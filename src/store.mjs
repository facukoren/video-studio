import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

import { DEFAULT_SETTINGS } from "./recipe.mjs";

const STATES = new Set([
  "queued",
  "running",
  "needs_configuration",
  "needs_attention",
  "failed",
  "completed",
]);
const STAGES = new Set([
  "queued",
  "download",
  "transcribe",
  "cut",
  "plan",
  "story",
  "broll",
  "render",
  "verify",
  "upload",
  "completed",
]);
const now = () => new Date().toISOString();
function fail(message, code = "validation", status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

export class Store {
  constructor(dbPath, {destinationFolderId = DEFAULT_SETTINGS.destinationFolderId} = {}) {
    if(destinationFolderId && !/^[A-Za-z0-9_-]{10,200}$/.test(destinationFolderId)) fail('Carpeta de destino inválida.');
    this.destinationFolderId = destinationFolderId;
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    if (dbPath !== ":memory:") chmodSync(dbPath, 0o600);
    this.db
      .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)")
      .run("settings", JSON.stringify({...DEFAULT_SETTINGS,destinationFolderId}));
    try {
      this.transaction(() => {
        const saved = this.getSettings();
        if (saved.destinationFolderId === destinationFolderId) return;
        // A first local startup may precede account configuration. Finish that
        // setup without losing budgets or rewriting durable job snapshots.
        if (saved.destinationFolderId)
          fail('La carpeta cambió. Usá un DATA_DIR nuevo para otra carpeta y conservá esta cola.', 'configuration_error', 503);
        this.db.prepare("UPDATE metadata SET value=? WHERE key=?")
          .run(JSON.stringify({...saved, destinationFolderId}), "settings");
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  getSettings() {
    return JSON.parse(
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get("settings")
        .value,
    );
  }
  updateSettings(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      fail("Configuración inválida.");
    const current = this.getSettings();
    for (const key of Object.keys(patch))
      if (
        ![
          "maxCreditsPerVideo",
          "maxBrolls",
          "destinationFolderId",
          "recipe",
        ].includes(key)
      )
        fail("Campo de configuración no permitido.");
    if (
      "destinationFolderId" in patch &&
      patch.destinationFolderId !== this.destinationFolderId
    )
      fail("La carpeta de destino es fija.");
    if ("recipe" in patch && patch.recipe !== current.recipe)
      fail("La receta de esta versión es fija.");
    if (
      "maxCreditsPerVideo" in patch &&
      patch.maxCreditsPerVideo !== null &&
      (typeof patch.maxCreditsPerVideo !== "number" ||
        !Number.isFinite(patch.maxCreditsPerVideo) ||
        patch.maxCreditsPerVideo < 0 ||
        patch.maxCreditsPerVideo > 10000)
    )
      fail("El límite de créditos debe estar entre 0 y 10000.");
    if (
      "maxBrolls" in patch &&
      (!Number.isInteger(patch.maxBrolls) ||
        patch.maxBrolls < 1 ||
        patch.maxBrolls > 8)
    )
      fail("La cantidad de B-rolls debe estar entre 1 y 8.");
    const next = { ...current, ...patch };
    this.db
      .prepare("UPDATE metadata SET value=? WHERE key=?")
      .run(JSON.stringify(next), "settings");
    return next;
  }
  createJob({ sourceUrl, idempotencyKey }) {
    if (
      typeof sourceUrl !== "string" ||
      typeof idempotencyKey !== "string" ||
      !idempotencyKey ||
      idempotencyKey.length > 200
    )
      fail("Solicitud de trabajo inválida.");
    return this.transaction(() => {
      const existing = this.db
        .prepare("SELECT payload FROM jobs WHERE idempotency_key=?")
        .get(idempotencyKey);
      if (existing) {
        const job = JSON.parse(existing.payload);
        if (job.sourceUrl !== sourceUrl)
          fail(
            "La clave de idempotencia corresponde a otro enlace.",
            "idempotency_conflict",
            409,
          );
        return job;
      }
      const timestamp = now();
      const job = {
        id: randomUUID(),
        sourceUrl,
        sourceName: null,
        status: "queued",
        stage: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        error: null,
        result: null,
        events: [],
        artifacts: {},
        idempotencyKey,
        destinationFolderId: this.destinationFolderId,
      };
      this.db
        .prepare(
          "INSERT INTO jobs (id,idempotency_key,status,created_at,payload) VALUES (?,?,?,?,?)",
        )
        .run(
          job.id,
          idempotencyKey,
          job.status,
          timestamp,
          JSON.stringify(job),
        );
      return job;
    });
  }
  getJobByKey(key) {
    const row=this.db.prepare("SELECT payload FROM jobs WHERE idempotency_key=?").get(key);
    return row?JSON.parse(row.payload):null;
  }
  createUploadedJob({id,idempotencyKey,source}) {
    if(!/^[a-f0-9-]{36}$/.test(id||'')||typeof idempotencyKey!=='string'||!idempotencyKey||idempotencyKey.length>200||!source?.path||!source?.name||!Number.isSafeInteger(source.size)||source.size<=0||!/^[a-f0-9]{64}$/.test(source.sha256||''))fail("Archivo subido inválido.");
    return this.transaction(()=>{
      const existing=this.getJobByKey(idempotencyKey);
      if(existing){
        if(existing.sourceType!=='upload'||existing.sourceName!==source.name||existing.artifacts.source.sha256!==source.sha256||existing.artifacts.source.size!==source.size)fail("La clave del envío corresponde a otro archivo.","idempotency_conflict",409);
        return existing;
      }
      const timestamp=now();
      const job={id,sourceUrl:null,sourceType:'upload',sourceName:source.name,status:'queued',stage:'queued',createdAt:timestamp,updatedAt:timestamp,error:null,result:null,events:[{stage:'download',message:'Archivo subido y validado. Listo para editar.',at:timestamp}],artifacts:{source},idempotencyKey,destinationFolderId:this.destinationFolderId};
      this.db.prepare("INSERT INTO jobs (id,idempotency_key,status,created_at,payload) VALUES (?,?,?,?,?)").run(id,idempotencyKey,job.status,timestamp,JSON.stringify(job));
      return job;
    });
  }
  listJobs() {
    return this.db
      .prepare("SELECT payload FROM jobs ORDER BY created_at DESC,rowid DESC")
      .all()
      .map((row) => JSON.parse(row.payload));
  }
  getJob(id) {
    const row = this.db.prepare("SELECT payload FROM jobs WHERE id=?").get(id);
    return row ? JSON.parse(row.payload) : null;
  }
  updateJob(id, patch) {
    return this.transaction(() => this.writeJob(id, patch));
  }
  writeJob(id, patch) {
    const job = this.getJob(id);
    if (!job) fail("Trabajo no encontrado.", "not_found", 404);
    if (patch.status && !STATES.has(patch.status)) fail("Estado inválido.");
    if (patch.stage && !STAGES.has(patch.stage)) fail("Etapa inválida.");
    const next = {
      ...job,
      ...patch,
      id: job.id,
      sourceUrl: job.sourceUrl,
      idempotencyKey: job.idempotencyKey,
      createdAt: job.createdAt,
      updatedAt: now(),
      artifacts: { ...job.artifacts, ...patch.artifacts },
    };
    this.db
      .prepare("UPDATE jobs SET status=?,payload=? WHERE id=?")
      .run(next.status, JSON.stringify(next), id);
    return next;
  }
  addEvent(id, { stage, message }) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) fail("Trabajo no encontrado.", "not_found", 404);
      return this.writeJob(id, {
        events: [...job.events, { stage, message, at: now() }].slice(-300),
      });
    });
  }
  claimJob() {
    return this.transaction(() => {
      if (
        this.db
          .prepare("SELECT id FROM jobs WHERE status='running' LIMIT 1")
          .get()
      )
        return null;
      const row = this.db
        .prepare(
          "SELECT id FROM jobs WHERE status='queued' AND COALESCE(json_extract(payload,'$.retryAfter'),0) <= ? ORDER BY created_at,rowid LIMIT 1",
        )
        .get(Date.now());
      return row
        ? this.writeJob(row.id, { status: "running", error: null })
        : null;
    });
  }
  retryJob(id) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) fail("Trabajo no encontrado.", "not_found", 404);
      if (
        !["failed", "needs_configuration", "needs_attention"].includes(
          job.status,
        )
      )
        fail(
          "Este trabajo no se puede reintentar en su estado actual.",
          "invalid_state",
          409,
        );
      return this.writeJob(id, { status: "queued", error: null, retryAfter: null });
    });
  }
  heartbeat() {
    const value = now();
    this.db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run("heartbeat", value);
    return value;
  }
  workerStatus() {
    const lastSeen =
      this.db.prepare("SELECT value FROM metadata WHERE key=?").get("heartbeat")
        ?.value ?? null;
    return {
      online: Boolean(lastSeen && Date.now() - Date.parse(lastSeen) < 45000),
      lastSeen,
    };
  }
  close() {
    this.db.close();
  }
}
