import express from "express";
import { registerUploads } from "./uploads.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { DriveClient, parseDriveFileUrl } from "./providers/drive.mjs";
import { registerGoogleSetup } from "./google-setup.mjs";
import { registerHiggsfieldSetup } from "./higgsfield-setup.mjs";

const publicJob = (job) =>
  Object.fromEntries(
    [
      "id",
      "sourceUrl",
      "sourceType",
      "sourceName",
      "status",
      "stage",
      "createdAt",
      "updatedAt",
      "error",
      "result",
      "events",
    ].map((key) => [key, job[key]]),
  );
function error(message, code = "validation", status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function loopback(address) {
  return (
    address === "::1" ||
    address === "127.0.0.1" ||
    address === "::ffff:127.0.0.1"
  );
}
function cookieValue(header, name) {
  for (const value of (header ?? "").split(";")) {
    const index = value.indexOf("=");
    if (value.slice(0, index).trim() === name)
      return value.slice(index + 1).trim();
  }
  return null;
}

export function createApp({
  store,
  config,
  integrationStatus = async () => [],
}) {
  const app = express();
  const sessions = new Map();
  const drive = config.driveClient ?? new DriveClient(config);
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src https://drive.google.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    let expected;
    try {
      expected = new URL(config.baseUrl);
    } catch {
      return next(
        error(
          "La URL del servidor no está configurada.",
          "configuration_error",
          503,
        ),
      );
    }
    if (req.headers.host !== expected.host)
      return next(error("Host no autorizado.", "forbidden", 403));
    const sessionId = cookieValue(req.headers.cookie, "kavion_session");
    const session = sessions.get(sessionId);
    if (session && session.expiresAt > Date.now()) req.session = session;
    else if (sessionId) sessions.delete(sessionId);
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : null;
    const authorized =
      config.accessToken
        ? (equal(token, config.accessToken) || req.session?.authenticated)
        : loopback(req.socket.remoteAddress);
    if (!authorized)
      return next(
        error(
          "El acceso está limitado al servidor local o a una sesión autorizada.",
          "unauthorized",
          401,
        ),
      );
    req.isAuthenticated = Boolean(
      config.accessToken && equal(token, config.accessToken),
    );
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "32kb", strict: true }));
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const expected = new URL(config.baseUrl).origin;
    if (
      req.headers.origin !== expected ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !req.session ||
      !equal(req.headers["x-csrf-token"], req.session.csrfToken)
    )
      return next(
        error(
          "La sesión o el origen no son válidos. Recargá la página.",
          "csrf",
          403,
        ),
      );
    next();
  });
  function requireSession(req, res) {
    if (req.session) return req.session;
    for (const [id, session] of sessions)
      if (session.expiresAt <= Date.now()) sessions.delete(id);
    if (sessions.size >= 2000) sessions.delete(sessions.keys().next().value);
    const id = randomBytes(32).toString("base64url");
    const session = {
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 24 * 3600000,
      authenticated: req.isAuthenticated,
    };
    sessions.set(id, session);
    req.session = session;
    res.append(
      "Set-Cookie",
      `kavion_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${new URL(config.baseUrl).protocol === "https:" ? "; Secure" : ""}`,
    );
    return session;
  }
  app.get("/api/status", async (req, res) => {
    const session = requireSession(req, res);
    const status = await integrationStatus();
    const settings = store.getSettings();
    const resource = Array.isArray(status)
      ? {
          ready:
            status.length > 0 &&
            status.every((item) => item.state === "ready") &&
            store.workerStatus().online,
          worker: store.workerStatus(),
          integrations: status,
          destination: {
            id: settings.destinationFolderId,
            name: "Carpeta de salida",
            url: settings.destinationFolderId ? `https://drive.google.com/drive/folders/${settings.destinationFolderId}` : null,
          },
        }
      : status;
    res.json({ ...resource, csrfToken: session.csrfToken });
  });
  app.get("/api/settings", (req, res) => res.json(store.getSettings()));
  registerGoogleSetup(app, {config});
  app.locals.higgsfieldSetup=registerHiggsfieldSetup(app, {config,setup:config.higgsfieldSetup});
  app.put("/api/settings", (req, res) =>
    res.json(store.updateSettings(req.body)),
  );
  app.get("/api/jobs", (req, res) => res.json(store.listJobs().map(publicJob)));
  app.get("/api/jobs/:id", (req, res) => {
    const job = store.getJob(req.params.id);
    if (!job) throw error("Trabajo no encontrado.", "not_found", 404);
    res.json(publicJob(job));
  });
  registerUploads(app, {store,config,publicJob});
  app.post("/api/jobs", (req, res) => {
    const { sourceUrl } = req.body ?? {};
    if (typeof sourceUrl !== "string" || sourceUrl.length > 2000)
      throw error("Ingresá un enlace de archivo de Google Drive válido.");
    const normalized = sourceUrl.trim();
    parseDriveFileUrl(normalized);
    const idempotencyKey = req.headers["idempotency-key"];
    if (
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)
    )
      throw error("Falta una clave de idempotencia válida.");
    const before = store
      .listJobs()
      .some((job) => job.idempotencyKey === idempotencyKey);
    const job = store.createJob({ sourceUrl: normalized, idempotencyKey });
    res.status(before ? 200 : 201).json(publicJob(job));
  });
  app.post("/api/jobs/:id/retry", (req, res) =>
    res.json(publicJob(store.retryJob(req.params.id))),
  );
  app.get("/api/auth/google", (req, res) => {
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw error("Abrí la conexión desde la aplicación.", "forbidden", 403);
    const session = requireSession(req, res);
    session.oauth = {
      state: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + 10 * 60000,
    };
    res.redirect(drive.getAuthUrl(session.oauth.state));
  });
  app.get("/api/auth/google/callback", async (req, res) => {
    const oauth = req.session?.oauth;
    if (
      !oauth ||
      oauth.expiresAt < Date.now() ||
      !equal(req.query.state, oauth.state)
    )
      throw error(
        "La autorización venció o no corresponde a esta sesión. Volvé a conectar Drive.",
        "oauth_state",
      );
    delete req.session.oauth;
    if (req.query.error) return res.redirect("/?google=error");
    if (typeof req.query.code !== "string" || req.query.code.length > 4096)
      throw error(
        "Google no devolvió un código de autorización.",
        "google_auth",
      );
    await drive.exchangeCode(req.query.code);
    res.redirect("/?google=connected");
  });
  app.get("/api/jobs/:id/media", async (req, res) => {
    const job = store.getJob(req.params.id);
    if (
      !job ||
      job.status !== "completed" ||
      job.artifacts.verification?.ok !== true
    )
      throw error("El resultado todavía no está disponible.", "not_found", 404);
    const file = job.artifacts.render?.path;
    if (typeof file !== "string")
      throw error(
        "El resultado local no está disponible. Abrilo en Drive.",
        "not_found",
        404,
      );
    let base, actual;
    try {
      base = await realpath(resolve(config.dataDir, "jobs", job.id));
      actual = await realpath(file);
    } catch {
      throw error(
        "El resultado local no está disponible. Abrilo en Drive.",
        "not_found",
        404,
      );
    }
    const rel = relative(base, actual);
    if (
      !rel ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      !actual.endsWith(".mp4")
    )
      throw error("Ruta de resultado no permitida.", "forbidden", 403);
    res.set({
      "Cache-Control": "private, no-store",
      "Content-Type": "video/mp4",
    });
    res.sendFile(actual);
  });
  app.use("/api", (req, res) =>
    res
      .status(404)
      .json({
        error: { code: "not_found", message: "Recurso no encontrado." },
      }),
  );
  app.use(
    express.static(config.publicDir, {
      dotfiles: "deny",
      index: "index.html",
      fallthrough: true,
    }),
  );
  app.use((req, res) => res.status(404).send("No encontrado."));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status =
      err.type === "entity.parse.failed"
        ? 400
        : err.type === "entity.too.large"
          ? 413
          : Number.isInteger(err.status)
            ? err.status
            : 500;
    res
      .status(status)
      .json({
        error: {
          code: err.code ?? (status === 500 ? "internal_error" : "validation"),
          message:
            err.type === "entity.parse.failed"
              ? "El archivo JSON no es válido. Elegí el archivo original descargado de Google."
              : status === 500
              ? "No se pudo completar la operación. Intentá nuevamente."
              : err.message,
        },
      });
  });
  return app;
}
