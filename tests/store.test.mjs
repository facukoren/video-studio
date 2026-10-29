import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";

const sourceUrl = "https://drive.google.com/file/d/abcdefghijklmnop/view";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "kavion-store-"));
  const path = join(dir, "queue.sqlite");
  const store = new Store(path);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, path };
}
test("queue and merged checkpoints survive reopening, idempotency retains one job", (t) => {
  const { store, path } = fixture(t);
  const job = store.createJob({ sourceUrl, idempotencyKey: "intent-1" });
  store.updateJob(job.id, {
    artifacts: { download: { path: "/private/input" } },
  });
  store.updateJob(job.id, { artifacts: { upload: { sessionUrl: "secret" } } });
  assert.equal(
    store.createJob({ sourceUrl, idempotencyKey: "intent-1" }).id,
    job.id,
  );
  assert.throws(
    () =>
      store.createJob({
        sourceUrl: sourceUrl.replace("abcdefghijklmnop", "differentfileid"),
        idempotencyKey: "intent-1",
      }),
    /idempotenc/i,
  );
  store.close();
  const reopened = new Store(path);
  assert.deepEqual(reopened.getJob(job.id).artifacts, {
    download: { path: "/private/input" },
    upload: { sessionUrl: "secret" },
  });
  assert.equal(reopened.listJobs().length, 1);
  reopened.close();
});
test("two database connections can claim only one active job", (t) => {
  const { store, path } = fixture(t);
  const second = new Store(path);
  t.after(() => second.close());
  const one = store.createJob({ sourceUrl, idempotencyKey: "one" });
  store.createJob({ sourceUrl, idempotencyKey: "two" });
  assert.equal(store.claimJob().id, one.id);
  assert.equal(second.claimJob(), null);
  store.updateJob(one.id, { status: "failed", error: "offline" });
  const next = second.claimJob();
  assert.notEqual(next.id, one.id);
  assert.equal(next.status, "running");
});
test("a waiting processor job retains its checkpoint and is not immediately claimed again", (t) => {
  const {store}=fixture(t);
  const waiting=store.createJob({sourceUrl,idempotencyKey:'waiting'});
  store.updateJob(waiting.id,{retryAfter:Date.now()+60000,artifacts:{review:{cuts:[]}}});
  assert.equal(store.claimJob(),null);
  store.updateJob(waiting.id,{retryAfter:Date.now()-1});
  const resumed=store.claimJob();
  assert.equal(resumed.id,waiting.id);
  assert.deepEqual(resumed.artifacts.review,{cuts:[]});
});
test("settings bound spending, keep fixed folder and recipe, and retry preserves artifacts", (t) => {
  const { store } = fixture(t);
  assert.equal(store.getSettings().maxCreditsPerVideo, null);
  for (const patch of [
    { maxCreditsPerVideo: -1 },
    { maxCreditsPerVideo: Infinity },
    { maxBrolls: 100 },
    { destinationFolderId: "other" },
    { recipe: "replace" },
  ])
    assert.throws(() => store.updateSettings(patch));
  assert.equal(
    store.updateSettings({ maxCreditsPerVideo: 5, maxBrolls: 2 })
      .maxCreditsPerVideo,
    5,
  );
  const job = store.createJob({ sourceUrl, idempotencyKey: "retry" });
  assert.throws(() => store.retryJob(job.id));
  store.updateJob(job.id, {
    status: "failed",
    artifacts: { broll: { operationId: "paid-1" } },
  });
  const retried = store.retryJob(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.artifacts.broll.operationId, "paid-1");
  store.heartbeat();
  assert.equal(store.workerStatus().online, true);
});
