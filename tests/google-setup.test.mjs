import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  stat,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { registerGoogleSetup } from "../src/google-setup.mjs";
import { DriveClient } from "../src/providers/drive.mjs";
import { loadConfig } from "../src/config.mjs";

const redirectUri = "https://studio.example.test/api/auth/google/callback";
const clientDocument = (suffix = "one") => ({
  web: {
    client_id: `123456-${suffix}.apps.googleusercontent.com`,
    client_secret: `private-secret-${suffix}`,
    redirect_uris: [redirectUri],
    project_id: "project-123",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
  },
});
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kavion-google-setup-"));
  const config = {
    dataDir: join(dir, "data"),
    publicDir: join(dir, "public"),
    googleClientFile: join(dir, "data", "google-client.json"),
    googleTokenPath: join(dir, "data", "google-tokens.json"),
    googleRedirectUri: redirectUri,
    ...overrides,
  };
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.publicDir, { recursive: true });
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  registerGoogleSetup(app, { config });
  app.use((error, req, res, next) =>
    res
      .status(error.status ?? 500)
      .json({
        error: {
          code: error.code ?? "error",
          message: error.status
            ? error.message
            : "No se pudo guardar la configuración.",
        },
      }),
  );
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const post = (client) =>
    fetch(base + "/api/setup/google", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client }),
    });
  return { dir, config, base, post };
}
test("setup rejects malformed, installed and mismatched-callback JSON without retaining credentials", async (t) => {
  const f = await fixture(t);
  const inputs = [
    null,
    [],
    {},
    { installed: clientDocument().web },
    { web: { ...clientDocument().web, client_id: 12 } },
    { web: { ...clientDocument().web, client_secret: "" } },
    { web: { ...clientDocument().web, redirect_uris: [redirectUri + "/"] } },
    { web: { ...clientDocument().web, redirect_uris: ["http://localhost"] } },
  ];
  for (const input of inputs) {
    const response = await f.post(input);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes("private-secret"));
  }
  await assert.rejects(() => stat(f.config.googleClientFile), {
    code: "ENOENT",
  });
});
test("setup atomically saves owner-only normalized credentials and never exposes secrets", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(f.base + "/api/setup/google")).json(), {
    configured: false,
    redirectUri,
  });
  const input = clientDocument();
  input.ignored = "not-needed";
  input.web.refresh_token = "never-save-this-token";
  const response = await f.post(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { configured: true, redirectUri });
  const saved = JSON.parse(await readFile(f.config.googleClientFile, "utf8"));
  assert.equal(saved.web.client_secret, input.web.client_secret);
  assert.equal(saved.web.refresh_token, undefined);
  assert.equal(saved.ignored, undefined);
  assert.equal((await stat(f.config.googleClientFile)).mode & 0o777, 0o600);
  const inode = (await stat(f.config.googleClientFile)).ino;
  await f.post(clientDocument("two"));
  assert.notEqual((await stat(f.config.googleClientFile)).ino, inode);
  assert.deepEqual((await readdir(f.config.dataDir)).sort(), ["google-client.json", "google-tokens.json.lock"]);
  assert.equal((await stat(f.config.googleTokenPath + ".lock")).mode & 0o777, 0o600);
  assert.deepEqual(await (await fetch(f.base + "/api/setup/google")).json(), {
    configured: true,
    redirectUri,
  });
});
test("rejected replacement leaves existing client intact", async (t) => {
  const f = await fixture(t);
  await f.post(clientDocument());
  const original = await readFile(f.config.googleClientFile, "utf8");
  assert.equal(
    (await f.post({ installed: clientDocument("bad").web })).status,
    400,
  );
  assert.equal(await readFile(f.config.googleClientFile, "utf8"), original);
});
test("import refuses public directory, paths outside data and symlink escape", async (t) => {
  for (const variant of ["public", "outside", "symlink"]) {
    const f = await fixture(t);
    if (variant === "public") {
      f.config.googleClientFile = join(f.config.publicDir, "client.json");
    } else if (variant === "outside") {
      f.config.googleClientFile = join(f.dir, "external-client.json");
    } else {
      await symlink(f.config.publicDir, join(f.config.dataDir, "linked"));
      f.config.googleClientFile = join(
        f.config.dataDir,
        "linked",
        "client.json",
      );
    }
    const response = await f.post(clientDocument());
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private-secret"));
    await assert.rejects(() => stat(f.config.googleClientFile), {
      code: "ENOENT",
    });
  }
});
test("existing Drive clients reload imported credentials for authorization and refresh without restart", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    fetch: async (url, options) => {
      calls.push(Object.fromEntries(options.body));
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    },
  });
  const drive = new DriveClient(f.config);
  assert.equal(drive.configured(), false);
  await f.post(clientDocument("first"));
  assert.equal(drive.configured(), true);
  assert.equal(
    new URL(drive.getAuthUrl("state")).searchParams.get("client_id"),
    clientDocument("first").web.client_id,
  );
  await drive.exchangeCode("one-code");
  assert.equal(calls.at(-1).client_id, clientDocument("first").web.client_id);
  const oldTokens = await readFile(f.config.googleTokenPath, "utf8");
  const conflicting = await f.post(clientDocument("second"));
  assert.equal(conflicting.status, 409);
  assert.equal((await conflicting.json()).error.code, "google_client_conflict");
  assert.equal(await readFile(f.config.googleTokenPath, "utf8"), oldTokens);
  assert.equal(
    new URL(drive.getAuthUrl("state")).searchParams.get("client_id"),
    clientDocument("first").web.client_id,
  );
  await writeFile(
    f.config.googleClientFile,
    JSON.stringify(clientDocument("second")),
  );
  assert.equal(
    new URL(drive.getAuthUrl("state")).searchParams.get("client_id"),
    clientDocument("second").web.client_id,
  );
  await assert.rejects(() => drive.accessToken(), /conect|cliente/i);
  await drive.exchangeCode("second-code");
  assert.equal(
    calls.at(-1).client_secret,
    clientDocument("second").web.client_secret,
  );
  const tokens = JSON.parse(await readFile(f.config.googleTokenPath, "utf8"));
  tokens.expiry_date = 0;
  await writeFile(f.config.googleTokenPath, JSON.stringify(tokens));
  await drive.accessToken();
  assert.equal(calls.at(-1).client_id, clientDocument("second").web.client_id);
  assert.equal(calls.at(-1).grant_type, "refresh_token");
});
test("environment credentials remain fallback but a broken imported client fails closed", async (t) => {
  const f = await fixture(t, {
    googleClientId: "legacy-client",
    googleClientSecret: "legacy-secret",
  });
  const drive = new DriveClient(f.config);
  assert.equal(drive.configured(), true);
  assert.equal(
    new URL(drive.getAuthUrl("state")).searchParams.get("client_id"),
    "legacy-client",
  );
  await writeFile(f.config.googleClientFile, "{not json private-secret");
  assert.equal(drive.configured(), false);
  assert.deepEqual(await (await fetch(f.base + "/api/setup/google")).json(), {
    configured: false,
    redirectUri,
  });
});
test("config exposes private default and optional OAuth client file paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kavion-google-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(
    loadConfig({ DATA_DIR: dir }).googleClientFile,
    join(dir, "google-client.json"),
  );
  const custom = join(dir, "custom.json");
  assert.equal(
    loadConfig({ DATA_DIR: dir, GOOGLE_CLIENT_FILE: custom }).googleClientFile,
    custom,
  );
});
test("same-client replacement preserves a live connection and does not alter tokens", async (t) => {
  const f = await fixture(t);
  await f.post(clientDocument());
  const token = {
    access_token: "existing-access",
    refresh_token: "existing-refresh",
    google_client_id: clientDocument().web.client_id,
    expiry_date: Date.now() + 3600000,
  };
  await writeFile(f.config.googleTokenPath, JSON.stringify(token), {
    mode: 0o600,
  });
  const replacement = clientDocument();
  replacement.web.client_secret = "rotated-client-secret";
  const response = await f.post(replacement);
  assert.equal(response.status, 200);
  assert.deepEqual(
    JSON.parse(await readFile(f.config.googleTokenPath, "utf8")),
    token,
  );
  assert.equal(
    await new DriveClient(f.config).accessToken(),
    "existing-access",
  );
});
test("legacy environment client with tokens rejects an unrelated imported client", async (t) => {
  const f = await fixture(t, {
    googleClientId: "legacy-client",
    googleClientSecret: "legacy-secret",
  });
  await writeFile(
    f.config.googleTokenPath,
    JSON.stringify({ refresh_token: "legacy-refresh" }),
  );
  const response = await f.post(clientDocument());
  assert.equal(response.status, 409);
  assert.ok(!(await response.text()).includes("legacy-refresh"));
  await assert.rejects(() => stat(f.config.googleClientFile), {
    code: "ENOENT",
  });
});
test("an import rechecks tokens committed by another process after its temporary file was staged", async (t) => {
  const f = await fixture(t);
  await f.post(clientDocument("first"));
  const original = await readFile(f.config.googleClientFile, "utf8");
  const importer = spawn(process.execPath, ["--input-type=module", "-e", `
    import express from 'express';
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    let config,server,resume;
    const originalOpen=fs.open;
    fs.open=async (...args)=>{
      const file=await originalOpen(...args);
      if(config&&String(args[0]).startsWith(config.googleClientFile+'.')&&String(args[0]).endsWith('.tmp')){
        const sync=file.sync.bind(file);
        file.sync=async()=>{
          await sync();
          await new Promise(resolve=>{resume=resolve;process.send({staged:true});});
        };
      }
      return file;
    };
    syncBuiltinESMExports();
    const {registerGoogleSetup}=await import(${JSON.stringify(new URL("../src/google-setup.mjs", import.meta.url).href)});
    process.on('message',async message=>{
      if(message.config){
        config=message.config;const app=express();app.use(express.json());
        registerGoogleSetup(app,{config});
        app.use((error,req,res,next)=>res.status(error.status??500).json({error:{code:error.code??'error'}}));
        server=app.listen(0,'127.0.0.1',()=>process.send({base:'http://127.0.0.1:'+server.address().port}));
      }else if(message.resume){resume();}
      else if(message.shutdown){server.close(()=>process.disconnect());}
    });
  `], {stdio:["ignore","ignore","pipe","ipc"]});
  t.after(()=>importer.kill());
  const ready=once(importer,"message");importer.send({config:f.config});
  const {base}=(await ready)[0];
  const staged=once(importer,"message");
  const pending=fetch(base+"/api/setup/google",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({client:clientDocument("second")})});
  assert.deepEqual((await staged)[0],{staged:true});
  const drive=new DriveClient({...f.config,fetch:async()=>Response.json({access_token:"new-access",refresh_token:"new-refresh",expires_in:3600})});
  await drive.exchangeCode("authorized-first-client");
  const authorized=await readFile(f.config.googleTokenPath,"utf8");
  importer.send({resume:true});
  const response=await pending;
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,"google_client_conflict");
  assert.equal(await readFile(f.config.googleClientFile,"utf8"),original);
  assert.equal(await readFile(f.config.googleTokenPath,"utf8"),authorized);
  assert.equal(await drive.accessToken(),"new-access");
  assert.ok(!(await readdir(f.config.dataDir)).some(name=>name.endsWith('.tmp')));
  const exited=once(importer,"exit");importer.send({shutdown:true});
  assert.equal((await exited)[0],0);
});
