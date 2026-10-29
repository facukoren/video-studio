import { readFileSync, statSync, realpathSync, openSync, closeSync, chmodSync, renameSync, fsyncSync } from "node:fs";
import {
  mkdir,
  realpath,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const MAX_CLIENT_BYTES = 32 * 1024;
const CLIENT_ID = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
function setupError(message, code = "google_client_invalid", status = 400) {
  return Object.assign(new Error(message), { code, status });
}
function contained(root, file) {
  const rel = relative(root, file);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
function filePath(config) {
  return (
    config.googleClientFile ||
    (config.dataDir ? resolve(config.dataDir, "google-client.json") : null)
  );
}
function publicRoot(config) {
  if (!config.publicDir) return null;
  try {
    return realpathSync(config.publicDir);
  } catch {
    return resolve(config.publicDir);
  }
}
function normalizedClient(document, redirectUri) {
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.installed ||
    !document.web ||
    typeof document.web !== "object" ||
    Array.isArray(document.web)
  )
    throw setupError(
      "Elegí el JSON de un cliente OAuth de tipo Aplicación web.",
    );
  const web = document.web;
  if (
    typeof web.client_id !== "string" ||
    web.client_id.length > 512 ||
    !CLIENT_ID.test(web.client_id) ||
    typeof web.client_secret !== "string" ||
    !web.client_secret ||
    web.client_secret.length > 4096 ||
    /\s/.test(web.client_secret)
  )
    throw setupError(
      "El archivo no contiene un ID y un secreto de cliente válidos.",
    );
  if (
    typeof redirectUri !== "string" ||
    !Array.isArray(web.redirect_uris) ||
    !web.redirect_uris.includes(redirectUri)
  )
    throw setupError(
      "El cliente de Google debe incluir exactamente el callback que muestra esta aplicación.",
      "google_callback_mismatch",
    );
  return {
    web: {
      client_id: web.client_id,
      client_secret: web.client_secret,
      redirect_uris: [redirectUri],
    },
  };
}

// Synchronous by design: configured()/getAuthUrl() are synchronous public APIs.
// Read every time so already-running API and worker processes see atomic imports.
export function readGoogleCredentials(config) {
  const path = filePath(config);
  if (path) {
    let info;
    try {
      info = statSync(path);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw setupError(
          "No se pudo leer el cliente de Google.",
          "google_client_unreadable",
          503,
        );
    }
    if (info) {
      try {
        if (!info.isFile() || info.size > MAX_CLIENT_BYTES)
          throw new Error("invalid file");
        const actual = realpathSync(path),
          publicDir = publicRoot(config);
        if (publicDir && contained(publicDir, actual))
          throw new Error("public client file");
        const { web } = normalizedClient(
          JSON.parse(readFileSync(actual, "utf8")),
          config.googleRedirectUri,
        );
        return {
          clientId: web.client_id,
          clientSecret: web.client_secret,
          source: "file",
        };
      } catch {
        throw setupError(
          "El archivo del cliente de Google no es válido. Volvé a cargar el JSON correcto.",
          "google_client_invalid",
          503,
        );
      }
    }
  }
  if (config.googleClientId && config.googleClientSecret)
    return {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      source: "environment",
    };
  return null;
}
function summary(config) {
  let configured = false;
  try {
    configured = Boolean(
      readGoogleCredentials(config) &&
        config.googleRedirectUri &&
        config.googleTokenPath,
    );
  } catch {}
  return { configured, redirectUri: config.googleRedirectUri };
}
async function importPath(config) {
  if (!config.dataDir)
    throw setupError(
      "Falta el directorio privado de configuración.",
      "configuration_error",
      503,
    );
  const dataDir = resolve(config.dataDir),
    target = resolve(filePath(config));
  if (!contained(dataDir, target) || target === dataDir)
    throw setupError(
      "El cliente debe guardarse en el directorio privado de la aplicación.",
      "configuration_error",
      503,
    );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const root = await realpath(dataDir),
    parent = await realpath(dirname(target)),
    actual = resolve(parent, target.slice(dirname(target).length + 1)),
    publicDir = publicRoot(config);
  if (!contained(root, parent) || (publicDir && contained(publicDir, actual)))
    throw setupError(
      "El cliente debe guardarse fuera del directorio público.",
      "configuration_error",
      503,
    );
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw setupError(
      "La ruta del cliente no es un archivo privado válido.",
      "configuration_error",
      503,
    );
  return target;
}
function guardClientReplacement(config, nextClientId) {
  if (!config.googleTokenPath) return;
  let tokens;
  try {
    tokens = JSON.parse(readFileSync(config.googleTokenPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw setupError(
      "Ya existe una conexión de Google que debe revisarse antes de cambiar el cliente.",
      "google_client_conflict",
      409,
    );
  }
  if (!tokens.access_token && !tokens.refresh_token) return;
  let existingId = tokens.google_client_id;
  if (!existingId) {
    try {
      existingId = readGoogleCredentials(config)?.clientId;
    } catch {}
  }
  if (existingId !== nextClientId)
    throw setupError(
      "Ya hay una conexión de Drive asociada a otro cliente. Revisá y desconectá esa autorización antes de cargar uno distinto.",
      "google_client_conflict",
      409,
    );
}
function commitClient(config, temporary, target, nextClientId, lockPath) {
  // Share DriveClient's persistent lock inode. Staging happens before this
  // short synchronous commit, so OAuth network requests never hold the lock.
  const lock = openSync(lockPath, "a", 0o600);
  try {
    chmodSync(lockPath, 0o600);
    const acquired = spawnSync("flock", ["--exclusive", "--wait", "5", "3"], {
      stdio: ["ignore", "ignore", "ignore", lock], timeout: 6000,
    });
    if (acquired.status !== 0)
      throw setupError("La conexión con Google se está actualizando. Intentá nuevamente.", "google_auth_busy", 503);
    // A callback may have saved tokens while the candidate file was staged.
    // Read tokens and legacy client identity again while their writer is locked.
    guardClientReplacement(config, nextClientId);
    renameSync(temporary, target);
    const directory = openSync(dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { closeSync(lock); }
}

// Register only after the app's session/origin/CSRF and JSON middleware.
export function registerGoogleSetup(app, { config }) {
  app.get("/api/setup/google", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(summary(config));
  });
  app.post("/api/setup/google", async (req, res) => {
    const client = normalizedClient(req.body?.client, config.googleRedirectUri);
    const target = await importPath(config);
    guardClientReplacement(config, client.web.client_id);
    const lockPath = `${resolve(config.googleTokenPath || target)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(client));
      await file.sync();
      await file.close();
      file = null;
      commitClient(config, temporary, target, client.web.client_id, lockPath);
    } catch (error) {
      if (error.code === "google_client_conflict" || error.code === "google_auth_busy") throw error;
      throw setupError(
        "No se pudo guardar el cliente de Google en el servidor.",
        "google_client_save_failed",
        503,
      );
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    res.set("Cache-Control", "no-store");
    res.json(summary(config));
  });
}
