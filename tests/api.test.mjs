import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { createApp } from "../src/app.mjs";

async function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kavion-api-"));
  const store = new Store(join(dir, "queue.sqlite"));
  const config = {
    host: "127.0.0.1",
    baseUrl: "http://127.0.0.1",
    dataDir: dir,
    publicDir: join(dir, "public"),
    ...extra,
  };
  const app = createApp({ store, config, integrationStatus: async () => [] });
  const server = await new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const response = await fetch(base + "/api/status");
  const status = await response.json();
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return {
    store,
    base,
    status,
    cookie,
    headers: {
      cookie,
      origin: base,
      "x-csrf-token": status.csrfToken,
      "content-type": "application/json",
    },
  };
}
test("browser session and CSRF gate same-origin writes and public jobs omit checkpoints", async (t) => {
  const f = await fixture(t);
  assert.ok(f.status.csrfToken);
  const body = JSON.stringify({
    sourceUrl: "https://drive.google.com/file/d/abcdefghijklmnop/view",
  });
  for (const headers of [
    { "content-type": "application/json" },
    { ...f.headers, origin: "https://evil.example" },
    { ...f.headers, "x-csrf-token": "bad" },
  ]) {
    const r = await fetch(f.base + "/api/jobs", {
      method: "POST",
      headers,
      body,
    });
    assert.equal(r.status, 403);
  }
  const headers = { ...f.headers, "idempotency-key": "intent-1" };
  const created = await fetch(f.base + "/api/jobs", {
    method: "POST",
    headers,
    body,
  });
  assert.equal(created.status, 201);
  const job = await created.json();
  f.store.updateJob(job.id, {
    artifacts: { upload: { sessionUrl: "secret" } },
    idempotencyKey: "never-expose",
  });
  const again = await fetch(f.base + "/api/jobs", {
    method: "POST",
    headers,
    body,
  });
  assert.equal((await again.json()).id, job.id);
  const detail = await (
    await fetch(f.base + "/api/jobs/" + job.id, {
      headers: { cookie: f.cookie },
    })
  ).json();
  assert.equal(detail.artifacts, undefined);
  assert.equal(detail.idempotencyKey, undefined);
  assert.ok(!JSON.stringify(detail).includes("secret"));
});
test("invalid sources and settings return structured validation errors", async (t) => {
  const f = await fixture(t);
  const bad = await fetch(f.base + "/api/jobs", {
    method: "POST",
    headers: { ...f.headers, "idempotency-key": "bad" },
    body: JSON.stringify({
      sourceUrl: "https://drive.google.com/drive/folders/folderid",
    }),
  });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error.message, "string");
  const settings = await fetch(f.base + "/api/settings", {
    method: "PUT",
    headers: f.headers,
    body: JSON.stringify({ maxCreditsPerVideo: -3 }),
  });
  assert.equal(settings.status, 400);
});
test("connection setup requires CSRF and malformed credential JSON never echoes secrets", async (t) => {
  const f=await fixture(t);
  for(const endpoint of ['/api/setup/google','/api/setup/higgsfield/start','/api/setup/higgsfield/complete']){
    const denied=await fetch(f.base+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
  }
  const bad=await fetch(f.base+'/api/setup/google',{method:'POST',headers:f.headers,body:'{"client_secret":"NEVER-ECHO-THIS", malformed'});
  assert.equal(bad.status,400);assert.ok(!(await bad.text()).includes('NEVER-ECHO-THIS'));
});
test("OAuth state binds callback to session, expires after use and never exchanges untrusted state", async (t) => {
  let exchanged = 0;
  const driveClient = {
    configured: () => true,
    getAuthUrl: (state) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
    exchangeCode: async () => {
      exchanged++;
    },
  };
  const f = await fixture(t, { driveClient });
  const start = await fetch(f.base + "/api/auth/google", {
    headers: { cookie: f.cookie },
    redirect: "manual",
  });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get(
    "state",
  );
  assert.ok(state);
  const wrong = await fetch(
    f.base + "/api/auth/google/callback?state=wrong&code=code",
    { headers: { cookie: f.cookie } },
  );
  assert.equal(wrong.status, 400);
  assert.equal(exchanged, 0);
  const ok = await fetch(
    f.base + `/api/auth/google/callback?state=${state}&code=code`,
    { headers: { cookie: f.cookie }, redirect: "manual" },
  );
  assert.equal(ok.status, 302);
  assert.equal(exchanged, 1);
  const replay = await fetch(
    f.base + `/api/auth/google/callback?state=${state}&code=code`,
    { headers: { cookie: f.cookie } },
  );
  assert.equal(replay.status, 400);
  assert.equal(exchanged, 1);
});
test("local preview requires verified completed media and refuses symlink escape", async (t) => {
  const { mkdir, writeFile, symlink } = await import("node:fs/promises");
  const f = await fixture(t);
  const job = f.store.createJob({
    sourceUrl: "https://drive.google.com/file/d/abcdefghijklmnop/view",
    idempotencyKey: "preview",
  });
  const queuePath = f.store.db.location();
  const dir = join(queuePath, "..", "jobs", job.id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "final.mp4");
  await writeFile(file, "video");
  f.store.updateJob(job.id, {
    status: "completed",
    artifacts: { render: { path: file } },
  });
  assert.equal(
    (await fetch(f.base + "/api/jobs/" + job.id + "/media")).status,
    404,
  );
  f.store.updateJob(job.id, { artifacts: { verification: { ok: true } } });
  const preview = await fetch(f.base + "/api/jobs/" + job.id + "/media");
  assert.equal(preview.status, 200);
  assert.equal(await preview.text(), "video");
  const outside = join(queuePath, "..", "private.mp4");
  await writeFile(outside, "private");
  const escape = join(dir, "escape.mp4");
  await symlink(outside, escape);
  f.store.updateJob(job.id, { artifacts: { render: { path: escape } } });
  assert.equal(
    (await fetch(f.base + "/api/jobs/" + job.id + "/media")).status,
    403,
  );
});
test("unrecognized Host is rejected before session or static responses", async (t) => {
  const f = await fixture(t);
  const { get } = await import("node:http");
  const response = await new Promise((resolve, reject) =>
    get(
      f.base + "/api/status",
      { headers: { host: "attacker.example" } },
      (res) => {
        res.resume();
        resolve(res);
      },
    ).on("error", reject),
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["set-cookie"], undefined);
});
