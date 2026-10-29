import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { DriveClient, parseDriveFileUrl } from "../src/providers/drive.mjs";

const id = "abcdefghijklmnop";
const folderId = "example-output-folder-12345";
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), "kavion-drive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const googleTokenPath = join(dir, "tokens.json");
  await writeFile(
    googleTokenPath,
    JSON.stringify({
      access_token: "private-token",
      refresh_token: "private-refresh",
      expiry_date: Date.now() + 3600000,
    }),
    { mode: 0o600 },
  );
  const client = new DriveClient({
    googleTokenPath,
    googleClientId: "client",
    googleClientSecret: "secret",
    destinationFolderId: folderId,
    googleRedirectUri: "http://127.0.0.1/api/auth/google/callback",
    maxInputBytes: 1024,
    fetch: handler,
  });
  return { client, dir };
}
test("Drive URL accepts only HTTPS file links and rejects folders, credentials and arbitrary hosts", () => {
  for (const url of [
    `https://drive.google.com/file/d/${id}/view`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/uc?id=${id}`,
  ])
    assert.equal(parseDriveFileUrl(url), id);
  for (const url of [
    "https://evil.test/x",
    "https://drive.google.com.evil.test/file/d/abc",
    "https://drive.google.com/drive/folders/abc",
    `http://drive.google.com/file/d/${id}/view`,
    `https://user@drive.google.com/file/d/${id}/view`,
  ])
    assert.throws(() => parseDriveFileUrl(url));
});
test("private download validates MIME and bounded size and sends OAuth authorization", async (t) => {
  const calls = [];
  const { client, dir } = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("alt=media")) return new Response("video");
    return json({
      id,
      name: "source.mp4",
      mimeType: "video/mp4",
      size: "5",
      version: "2",
    });
  });
  const result = await client.download(id, join(dir, "source.mp4"));
  assert.equal(result.name, "source.mp4");
  assert.equal(await readFile(result.path, "utf8"), "video");
  assert.ok(
    calls.every(
      (call) => call.options.headers.Authorization === "Bearer private-token",
    ),
  );
});
test("download rejects non-video and oversized media before requesting bytes", async (t) => {
  let requests = 0;
  const { client, dir } = await fixture(t, async () => {
    requests++;
    return json({
      id,
      name: "document",
      mimeType: "application/pdf",
      size: "4000",
    });
  });
  await assert.rejects(
    () => client.download(id, join(dir, "file")),
    /video|tamaño/i,
  );
  assert.equal(requests, 1);
});
test("lost upload response reconciles matching appProperties and never creates a duplicate", async (t) => {
  let existing = false,
    creates = 0;
  const checkpoints = [];
  const remote = {
    id: "resultid12345",
    name: "edit.mp4",
    size: "5",
    mimeType: "video/mp4",
    parents: [folderId],
    appProperties: { kavionJobId: "job-1" },
  };
  const { client, dir } = await fixture(t, async (url, options) => {
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files" && options.method === "GET")
      return json({ files: existing ? [remote] : [] });
    if (u.pathname.endsWith("/generateIds")) return json({ ids: [remote.id] });
    if (
      u.pathname === "/upload/drive/v3/files" &&
      !u.searchParams.has("upload_id")
    ) {
      creates++;
      assert.equal(JSON.parse(options.body).appProperties.kavionJobId, "job-1");
      return new Response(null, {
        status: 200,
        headers: {
          location:
            "https://www.googleapis.com/upload/drive/v3/files?upload_id=session",
        },
      });
    }
    if (u.searchParams.has("upload_id")) {
      existing = true;
      throw new Error("socket lost");
    }
    if (u.pathname.endsWith(remote.id)) return json(remote);
    throw new Error("Unexpected request " + url);
  });
  const path = join(dir, "edit.mp4");
  await writeFile(path, "video");
  const result = await client.upload(path, {
    jobId: "job-1",
    name: "edit.mp4",
    folderId,
    onCheckpoint: async (checkpoint) => checkpoints.push(checkpoint),
  });
  assert.equal(result.fileId, remote.id);
  assert.equal(creates, 1);
  assert.ok(checkpoints.some((value) => value.sessionUrl));
});
test("resumable upload queries committed byte offset after restart and verifies metadata", async (t) => {
  const remote = {
    id: "resultid12345",
    name: "edit.mp4",
    size: "5",
    mimeType: "video/mp4",
    parents: [folderId],
    appProperties: { kavionJobId: "job-2" },
  };
  let uploadedBody;
  const { client, dir } = await fixture(t, async (url, options) => {
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files") return json({ files: [] });
    if (u.searchParams.has("upload_id")) {
      if (options.headers["Content-Range"] === "bytes */5")
        return new Response(null, {
          status: 308,
          headers: { range: "bytes=0-1" },
        });
      assert.equal(options.headers["Content-Range"], "bytes 2-4/5");
      uploadedBody = Buffer.from(options.body).toString();
      return json(remote);
    }
    if (u.pathname.endsWith(remote.id)) return json(remote);
    throw new Error("Unexpected request " + url);
  });
  const path = join(dir, "edit.mp4");
  await writeFile(path, "video");
  const result = await client.upload(path, {
    jobId: "job-2",
    name: "edit.mp4",
    folderId,
    checkpoint: {
      sessionUrl:
        "https://www.googleapis.com/upload/drive/v3/files?upload_id=session",
      size: 5,
    },
    onCheckpoint: async () => {},
  });
  assert.equal(uploadedBody, "deo");
  assert.equal(result.fileId, remote.id);
});
for (const withLocation of [false, true]) {
  test(`native fetch resumes 308 uploads ${withLocation ? "with Location without following it" : "without Location"}`, async (t) => {
    const chunkSize = 8 * 1024 * 1024, size = chunkSize + 5;
    const source = Buffer.alloc(size, 97), ranges = [], modes = [], checkpoints = [], serverErrors = [];
    const remote = {id:"nativeupload12345",name:"edit.mp4",size:String(size),mimeType:"video/mp4",parents:[folderId],appProperties:{kavionJobId:"native-resume"}};
    let redirectsFollowed = 0;
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/must-not-follow") { redirectsFollowed++;res.writeHead(500);res.end();return; }
        if (url.pathname === "/metadata-redirect") {res.writeHead(302,{Location:"/must-not-follow"});res.end();return;}
        assert.equal(req.headers.authorization,"Bearer private-token");
        if (url.pathname === "/drive/v3/files") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify({files:[]}));return;}
        if (url.pathname === `/drive/v3/files/${remote.id}`) {res.setHeader("Content-Type","application/json");res.end(JSON.stringify(remote));return;}
        assert.equal(url.pathname,"/upload/drive/v3/files");
        assert.equal(req.method,"PUT");
        const buffers=[];for await (const buffer of req) buffers.push(buffer);
        const body=Buffer.concat(buffers),range=req.headers["content-range"];ranges.push(range);
        const redirectHeaders=withLocation?{Location:"/must-not-follow"}:{};
        if(range===`bytes */${size}`){
          assert.equal(body.length,0);
          res.writeHead(308,{Range:"bytes=0-1",...redirectHeaders});res.end();return;
        }
        if(range===`bytes 2-${chunkSize+1}/${size}`){
          assert.deepEqual(body,source.subarray(2,chunkSize+2));
          res.writeHead(308,{Range:`bytes=0-${chunkSize+1}`,...redirectHeaders});res.end();return;
        }
        assert.equal(range,`bytes ${chunkSize+2}-${size-1}/${size}`);
        assert.deepEqual(body,source.subarray(chunkSize+2));
        res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:remote.id}));
      } catch(error) {serverErrors.push(error);res.writeHead(500);res.end();}
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    const base=`http://127.0.0.1:${server.address().port}`;
    const {client,dir}=await fixture(t,(url,options)=>{
      const original=new URL(url);modes.push({path:original.pathname,redirect:options.redirect});
      // Keep real native fetch handling; substitute only the remote transport origin.
      return fetch(new URL(original.pathname+original.search,base),options);
    });
    const file=join(dir,"edit.mp4");await writeFile(file,source);
    const result=await client.upload(file,{
      jobId:"native-resume",name:"edit.mp4",folderId,
      checkpoint:{sessionUrl:"https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture",size,offset:0},
      onCheckpoint:async value=>checkpoints.push(value),
    });
    assert.equal(result.fileId,remote.id);
    assert.deepEqual(ranges,[`bytes */${size}`,`bytes 2-${chunkSize+1}/${size}`,`bytes ${chunkSize+2}-${size-1}/${size}`]);
    assert.deepEqual(checkpoints.map(value=>value.offset),[chunkSize+2,size]);
    assert.ok(modes.filter(value=>value.path==="/upload/drive/v3/files").every(value=>value.redirect==="manual"));
    assert.ok(modes.filter(value=>value.path.startsWith("/drive/v3/")).every(value=>value.redirect==="error"));
    if(withLocation)await assert.rejects(()=>client.request("https://www.googleapis.com/metadata-redirect",{redirect:"follow"}),TypeError);
    assert.equal(redirectsFollowed,0);
    assert.deepEqual(serverErrors,[]);
  });
}
test("resumable session URL cannot exfiltrate bearer credentials", async (t) => {
  let calls = 0;
  const { client, dir } = await fixture(t, async () => {
    calls++;
    return json({ files: [] });
  });
  const path = join(dir, "edit.mp4");
  await writeFile(path, "video");
  await assert.rejects(
    () =>
      client.upload(path, {
        jobId: "job-3",
        name: "edit.mp4",
        folderId,
        checkpoint: { sessionUrl: "https://evil.test/upload", size: 5 },
      }),
    /sesión|session/i,
  );
  assert.ok(calls <= 1);
});
test("an upload is not successful unless remote size, parent and job property match", async (t) => {
  const { client, dir } = await fixture(t, async (url) => {
    if (new URL(url).pathname === "/drive/v3/files")
      return json({ files: [{ id: "resultid12345" }] });
    return json({
      id: "resultid12345",
      name: "edit.mp4",
      size: "4",
      mimeType: "video/mp4",
      parents: [folderId],
      appProperties: { kavionJobId: "job-4" },
    });
  });
  const path = join(dir, "edit.mp4");
  await writeFile(path, "video");
  await assert.rejects(
    () => client.upload(path, { jobId: "job-4", name: "edit.mp4", folderId }),
    /no coincide/i,
  );
});
test("expired tokens refresh through OAuth and persist with owner-only permissions", async (t) => {
  let refreshes = 0;
  const { client } = await fixture(t, async (url, options) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      refreshes++;
      assert.equal(options.body.get("grant_type"), "refresh_token");
      return json({ access_token: "renewed-token", expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, "Bearer renewed-token");
    return json({
      id: folderId,
      name: "Folder",
      mimeType: "application/vnd.google-apps.folder",
      capabilities: { canAddChildren: true },
    });
  });
  await writeFile(
    client.config.googleTokenPath,
    JSON.stringify({ refresh_token: "private-refresh", expiry_date: 0 }),
  );
  assert.equal((await client.check()).state, "ready");
  assert.equal(refreshes, 1);
  assert.equal((await stat(client.config.googleTokenPath)).mode & 0o777, 0o600);
  assert.equal(
    JSON.parse(await readFile(client.config.googleTokenPath, "utf8"))
      .refresh_token,
    "private-refresh",
  );
});
test("new consent replaces Testing refresh expiry and all previous authorization metadata", async (t) => {
  const response = { access_token: "production-access", refresh_token: "production-refresh", expires_in: 3600, token_type: "Bearer" };
  const { client } = await fixture(t, async () => json(response));
  await writeFile(client.config.googleTokenPath, JSON.stringify({
    access_token: "testing-access", refresh_token: "testing-refresh",
    refresh_token_expires_in: 604799, google_client_id: "client",
    id_token: "previous-identity", scope: "previous-scope", token_generation: "previous-generation",
    expiry_date: Date.now() + 3600000,
  }));
  await client.exchangeCode("new-production-consent");
  const saved = JSON.parse(await readFile(client.config.googleTokenPath, "utf8"));
  assert.equal(saved.refresh_token_expires_in, undefined);
  assert.equal(saved.id_token, undefined);
  assert.equal(saved.scope, undefined);
  assert.equal(saved.access_token, response.access_token);
  assert.equal(saved.refresh_token, response.refresh_token);
  assert.equal(saved.google_client_id, "client");
  assert.match(saved.token_generation, /^[a-f0-9-]{36}$/);
  assert.ok(saved.expiry_date > Date.now() + 3500000);
  response.refresh_token_expires_in = 1209600;
  await client.exchangeCode("new-time-limited-consent");
  assert.equal(JSON.parse(await readFile(client.config.googleTokenPath, "utf8")).refresh_token_expires_in, 1209600);
});
test("consent without a fresh refresh token cannot mix a new account with the previous account", async (t) => {
  let returnedRefresh;
  const { client } = await fixture(t, async () => json({
    access_token: "new-account-access", refresh_token: returnedRefresh, expires_in: 3600,
  }));
  await writeFile(client.config.googleTokenPath, JSON.stringify({
    access_token: "old-account-access", refresh_token: "old-account-refresh",
    google_client_id: "client", token_generation: "previous-generation", expiry_date: Date.now()+3600000,
  }));
  const original = await readFile(client.config.googleTokenPath, "utf8");
  const auth = new URL(client.getAuthUrl("state"));
  assert.equal(auth.searchParams.get("access_type"), "offline");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  for (returnedRefresh of [undefined, null, "", " ", {}, 123]) {
    await assert.rejects(() => client.exchangeCode("new-account-consent"), {code: "google_auth", status: 400});
    assert.equal(await readFile(client.config.googleTokenPath, "utf8"), original);
  }
  assert.equal(await client.accessToken(), "old-account-access");
});
test("a worker refresh cannot replace a newer authorization saved by another process", async (t) => {
  const { client } = await fixture(t, async () => json({
    access_token: "reconnected-access", refresh_token: "reconnected-refresh", expires_in: 3600,
  }));
  await writeFile(client.config.googleTokenPath, JSON.stringify({
    refresh_token: "previous-refresh", expiry_date: 0,
  }));
  const worker = spawn(process.execPath, ["--input-type=module", "-e", `
    import {DriveClient} from ${JSON.stringify(new URL("../src/providers/drive.mjs", import.meta.url).href)};
    process.once('message', async config => {
      try {
        const client = new DriveClient({...config,fetch:async()=>{
          process.send({ready:true});
          await new Promise(resolve=>process.once('message',resolve));
          return Response.json({access_token:'stale-access',refresh_token:'stale-refresh',expires_in:3600});
        }});
        process.send({token:await client.accessToken()});
      } catch(error) {process.send({error:error.message});}
      process.disconnect();
    });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => worker.kill());
  let stderr = "";worker.stderr.on("data",chunk=>{stderr += chunk;});
  const ready = once(worker, "message");
  worker.send({...client.config,fetch:undefined});
  assert.deepEqual((await ready)[0], {ready:true});
  await client.exchangeCode("new-authorization");
  const reconnected = JSON.parse(await readFile(client.config.googleTokenPath, "utf8"));
  const result = once(worker, "message");
  const exit = once(worker, "exit");
  worker.send({finish:true});
  assert.deepEqual((await result)[0], {token:"reconnected-access"});
  assert.equal((await exit)[0], 0, stderr);
  assert.deepEqual(JSON.parse(await readFile(client.config.googleTokenPath, "utf8")), reconnected);
  assert.match(reconnected.token_generation, /^[a-f0-9-]{36}$/);
});
test("concurrent refresh results keep the first committed token generation", async (t) => {
  const arrivals = [], replies = [];
  const { client } = await fixture(t, async () => {
    const reply=Promise.withResolvers();replies.push(reply);arrivals.shift()?.();
    return reply.promise;
  });
  await writeFile(client.config.googleTokenPath, JSON.stringify({refresh_token:"old-refresh",expiry_date:0}));
  const second=new DriveClient(client.config);
  const firstStarted=new Promise(resolve=>arrivals.push(resolve));
  const first=client.accessToken();await firstStarted;
  const secondStarted=new Promise(resolve=>arrivals.push(resolve));
  const other=second.accessToken();await secondStarted;
  replies[0].resolve(json({access_token:"winner",refresh_token:"winner-refresh",expires_in:3600}));
  assert.equal(await first,"winner");
  const committed=await readFile(client.config.googleTokenPath,"utf8");
  replies[1].resolve(json({access_token:"discarded",refresh_token:"discarded-refresh",expires_in:3600}));
  assert.equal(await other,"winner");
  assert.equal(await readFile(client.config.googleTokenPath,"utf8"),committed);
});
test("streaming download detects unexpected extra bytes and removes its temporary file", async (t) => {
  const { readdir } = await import("node:fs/promises");
  const { client, dir } = await fixture(t, async (url) =>
    String(url).includes("alt=media")
      ? new Response("too-many-bytes")
      : json({ id, name: "video.mp4", mimeType: "video/mp4", size: "5" }),
  );
  await assert.rejects(
    () => client.download(id, join(dir, "input.mp4")),
    /supera/i,
  );
  assert.deepEqual(
    (await readdir(dir)).filter((file) => file !== "tokens.json"),
    [],
  );
});
test("allocated Drive file ID survives ambiguous session creation and prevents duplication even when search lags", async (t) => {
  let checkpoint = {},
    attempt = 0,
    allocated = 0;
  const remote = {
    id: "allocatedfile12345",
    name: "edit.mp4",
    size: "5",
    mimeType: "video/mp4",
    parents: [folderId],
    appProperties: { kavionJobId: "job-allocated" },
  };
  const { client, dir } = await fixture(t, async (url, options) => {
    const u = new URL(url);
    if (u.pathname === "/drive/v3/files") return json({ files: [] });
    if (u.pathname.endsWith("/generateIds")) {
      allocated++;
      return json({ ids: [remote.id] });
    }
    if (u.pathname === "/upload/drive/v3/files") {
      assert.equal(JSON.parse(options.body).id, remote.id);
      assert.equal(checkpoint.targetFileId, remote.id);
      if (attempt++ === 0) throw new Error("connection lost");
      return new Response(null, { status: 409 });
    }
    if (u.pathname.endsWith(remote.id)) return json(remote);
    throw new Error("Unexpected " + url);
  });
  const path = join(dir, "edit.mp4");
  await writeFile(path, "video");
  const options = {
    jobId: "job-allocated",
    name: "edit.mp4",
    folderId,
    onCheckpoint: async (value) => {
      checkpoint = value;
    },
  };
  await assert.rejects(() => client.upload(path, options));
  const result = await client.upload(path, { ...options, checkpoint });
  assert.equal(result.fileId, remote.id);
  assert.equal(allocated, 1);
});
