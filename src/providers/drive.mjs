import {
  mkdir,
  readFile,
  rename,
  stat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { openSync, closeSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, fsyncSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readGoogleCredentials } from "../google-setup.mjs";

const API = "https://www.googleapis.com/drive/v3";

const ID = /^[A-Za-z0-9_-]{10,200}$/;
function fail(message, code = "drive_error", status = 502) {
  throw Object.assign(new Error(message), { code, status });
}
function requireId(id) {
  if (typeof id !== "string" || !ID.test(id))
    fail("Identificador de Drive inválido.", "validation", 400);
  return id;
}
export function parseDriveFileUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    fail(
      "Ingresá un enlace de archivo de Google Drive válido.",
      "validation",
      400,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drive.google.com" ||
    url.port ||
    url.username ||
    url.password
  )
    fail(
      "El enlace debe ser HTTPS y pertenecer a drive.google.com.",
      "validation",
      400,
    );
  const match = url.pathname.match(
    /^\/file\/d\/([A-Za-z0-9_-]+)(?:\/(?:view|preview|edit))?\/?$/,
  );
  const id =
    match?.[1] ??
    (["/open", "/uc"].includes(url.pathname)
      ? url.searchParams.get("id")
      : null);
  return requireId(id);
}
function validSession(value) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    !url ||
    url.origin !== "https://www.googleapis.com" ||
    url.pathname !== "/upload/drive/v3/files" ||
    !url.searchParams.has("upload_id") ||
    url.username ||
    url.password
  )
    fail(
      "La sesión de subida guardada no es válida.",
      "upload_session_invalid",
    );
  return url.href;
}
function safeName(name) {
  return String(name)
    .replace(/[\u0000-\u001f\u007f\/\\]/g, "_")
    .slice(0, 180);
}

export class DriveClient {
  constructor(config) {
    this.config = config;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.refreshing = null;
  }
  credentials() {
    let credentials;
    try {
      credentials = readGoogleCredentials(this.config);
    } catch {}
    if (
      !credentials ||
      !this.config.googleRedirectUri ||
      !this.config.googleTokenPath
    )
      fail(
        "Configurá el cliente OAuth de Google en el servidor.",
        "needs_configuration",
        503,
      );
    return credentials;
  }
  configured() {
    try {
      this.credentials();
      return true;
    } catch {
      return false;
    }
  }
  getAuthUrl(state) {
    const credentials = this.credentials();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: credentials.clientId,
      redirect_uri: this.config.googleRedirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive",
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    return url.href;
  }
  async saveTokens(tokens, { expectedTokens, credentials } = {}) {
    const path = resolve(this.config.googleTokenPath);
    if (this.config.publicDir) {
      const rel = relative(resolve(this.config.publicDir), path);
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel)))
        fail(
          "Las credenciales deben guardarse fuera del directorio público.",
          "configuration_error",
        );
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // flock is attached to the inherited open file description. The parent
    // retains that descriptor until the short synchronous commit finishes;
    // the kernel releases it even if either app process crashes.
    const lock = openSync(`${path}.lock`, "a", 0o600);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      chmodSync(`${path}.lock`, 0o600);
      const acquired = spawnSync("flock", ["--exclusive", "--wait", "5", "3"], {
        stdio: ["ignore", "ignore", "ignore", lock], timeout: 6000,
      });
      if (acquired.status !== 0)
        fail("La conexión con Google se está actualizando. Intentá nuevamente.", "google_auth_busy", 503);
      if (credentials && this.credentials().clientId !== credentials.clientId)
        fail("El cliente de Google cambió. Volvé a conectar Drive.", "needs_configuration", 503);
      let current = {};
      try { current = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") fail("No se pudo leer la conexión de Google.", "needs_configuration", 503); }
      if (expectedTokens && JSON.stringify(current) !== JSON.stringify(expectedTokens)) return false;
      const next = { ...tokens, token_generation: randomUUID() };
      writeFileSync(temporary, JSON.stringify(next), {
        mode: 0o600,
        flag: "wx",
      });
      const file = openSync(temporary, "r");
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return true;
    } finally {
      try { unlinkSync(temporary); } catch {}
      closeSync(lock);
    }
  }
  async exchangeCode(code) {
    const credentials = this.credentials();
    const response = await this.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: this.config.googleRedirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      fail(
        "Google rechazó la autorización. Volvé a conectar Drive.",
        "google_auth",
        400,
      );
    const tokens = await response.json();
    if (!tokens.access_token)
      fail("Google no devolvió una credencial válida.", "google_auth");
    // Every explicit connection requests offline consent. A client ID does
    // not identify the Google account, so never borrow an earlier grant's
    // refresh token or metadata when saving this new authorization.
    if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token.trim())
      fail("Google no devolvió permiso de acceso continuo. Volvé a conectar Drive y autorizá el acceso.", "google_auth", 400);
    await this.saveTokens({
      ...tokens,
      google_client_id: credentials.clientId,
      expiry_date: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    }, { credentials });
  }
  async readTokens() {
    try {
      return JSON.parse(await readFile(this.config.googleTokenPath, "utf8"));
    } catch {
      fail("Conectá Google Drive para continuar.", "needs_configuration", 503);
    }
  }
  async accessToken() {
    const credentials = this.credentials();
    const tokens = await this.readTokens();
    if (
      (tokens.google_client_id &&
        tokens.google_client_id !== credentials.clientId) ||
      (!tokens.google_client_id && credentials.source === "file")
    )
      fail(
        "Volvé a conectar Google Drive con el cliente configurado.",
        "needs_configuration",
        503,
      );
    if (tokens.access_token && Number(tokens.expiry_date) > Date.now() + 60000)
      return tokens.access_token;
    if (!tokens.refresh_token)
      fail("Volvé a conectar Google Drive.", "needs_configuration", 503);
    if (!this.refreshing)
      this.refreshing = (async () => {
        const response = await this.fetch(
          "https://oauth2.googleapis.com/token",
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: credentials.clientId,
              client_secret: credentials.clientSecret,
              refresh_token: tokens.refresh_token,
              grant_type: "refresh_token",
            }),
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!response.ok)
          fail(
            "La conexión con Google venció. Volvé a conectar Drive.",
            "needs_configuration",
            503,
          );
        const result = await response.json();
        if (!result.access_token)
          fail("Google no devolvió una credencial válida.", "google_auth");
        const saved = await this.saveTokens({
          ...tokens,
          ...result,
          google_client_id: credentials.clientId,
          expiry_date: Date.now() + (Number(result.expires_in) || 3600) * 1000,
        }, { expectedTokens: tokens, credentials });
        if (!saved) {
          // A callback or another process committed a newer generation while
          // this network request was pending. Never restore the old identity.
          const currentCredentials = this.credentials();
          const current = await this.readTokens();
          const sameClient = current.google_client_id === currentCredentials.clientId ||
            (!current.google_client_id && currentCredentials.source === "environment");
          if (sameClient && current.access_token && Number(current.expiry_date) > Date.now() + 60000)
            return current.access_token;
          fail("La conexión con Google cambió. Intentá nuevamente.", "needs_configuration", 503);
        }
        return result.access_token;
      })().finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  async request(url, options = {}) {
    const token = await this.accessToken();
    const response = await this.fetch(String(url), {
      ...options,
      method: options.method ?? "GET",
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      redirect: options.redirect === "manual" ? "manual" : "error",
      signal: AbortSignal.timeout(120000),
    });
    return response;
  }
  async checked(url, options) {
    const response = await this.request(url, options);
    if (!response.ok)
      fail(
        response.status === 401 || response.status === 403
          ? "Google Drive no autorizó esta operación. Revisá la conexión y los permisos."
          : `Google Drive no pudo completar la operación (HTTP ${response.status}).`,
        response.status === 401 ? "needs_configuration" : "drive_error",
      );
    return response.json();
  }
  async check() {
    if (!this.config.destinationFolderId) return {state:'missing',detail:'Configurá DRIVE_DESTINATION_FOLDER_ID con tu carpeta de salida.'};
    if (!this.configured())
      return {
        state: "missing",
        detail: "Falta configurar el cliente OAuth de Google.",
      };
    try {
      const folder = await this.checked(
        `${API}/files/${requireId(this.config.destinationFolderId)}?fields=id,name,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`,
      );
      if (
        folder.mimeType !== "application/vnd.google-apps.folder" ||
        !folder.capabilities?.canAddChildren
      )
        return {
          state: "error",
          detail: "La cuenta no puede subir archivos a la carpeta de destino.",
        };
      return {
        state: "ready",
        detail: "Google Drive conectado y carpeta con permiso de escritura.",
        destination: {
          id: folder.id,
          name: folder.name,
          url: `https://drive.google.com/drive/folders/${folder.id}`,
        },
      };
    } catch (error) {
      return {
        state: error.code === "needs_configuration" ? "missing" : "error",
        detail: error.message,
      };
    }
  }
  async download(fileId, destination) {
    requireId(fileId);
    const metadata = await this.checked(
      `${API}/files/${fileId}?fields=id,name,mimeType,size,version,trashed,capabilities(canDownload)&supportsAllDrives=true`,
    );
    const size = Number(metadata.size);
    const max = this.config.maxInputBytes ?? 2 * 1024 ** 3;
    if (
      metadata.trashed ||
      !metadata.mimeType?.startsWith("video/") ||
      metadata.capabilities?.canDownload === false
    )
      fail(
        "El archivo debe ser un video descargable de Google Drive.",
        "invalid_media",
        400,
      );
    if (!Number.isSafeInteger(size) || size <= 0 || size > max)
      fail(
        "El tamaño del video supera el límite o no es válido.",
        "invalid_media",
        400,
      );
    const response = await this.request(
      `${API}/files/${fileId}?alt=media&supportsAllDrives=true`,
    );
    if (!response.ok || !response.body)
      fail("No se pudo descargar el video privado de Drive.");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.part`;
    const file = await open(temporary, "wx", 0o600);
    let received = 0;
    try {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > max || received > size)
          fail(
            "El tamaño descargado supera el límite esperado.",
            "invalid_media",
            400,
          );
        await file.writeFile(chunk);
      }
      await file.close();
      if (received !== size)
        fail("La descarga quedó incompleta. Reintentá este trabajo.");
      await rename(temporary, destination);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return {
      path: destination,
      name: metadata.name,
      mimeType: metadata.mimeType,
      size,
      id: fileId,
      version: metadata.version,
    };
  }
  async verifyUpload(fileId, { jobId, folderId, size }) {
    const file = await this.checked(
      `${API}/files/${requireId(fileId)}?fields=id,name,size,mimeType,parents,appProperties,trashed&supportsAllDrives=true`,
    );
    if (
      file.trashed ||
      Number(file.size) !== size ||
      file.mimeType !== "video/mp4" ||
      !file.parents?.includes(folderId) ||
      file.appProperties?.kavionJobId !== jobId
    )
      fail(
        "Drive devolvió un archivo que no coincide con el resultado esperado.",
        "upload_mismatch",
      );
    return {
      fileId: file.id,
      url: `https://drive.google.com/file/d/${file.id}/view`,
      filename: file.name,
    };
  }
  async reconcile({ jobId, folderId, size }) {
    const escape = (value) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const url = new URL(`${API}/files`);
    url.search = new URLSearchParams({
      q: `trashed = false and '${escape(folderId)}' in parents and appProperties has { key='kavionJobId' and value='${escape(jobId)}' }`,
      fields: "files(id)",
      spaces: "drive",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      pageSize: "100",
    }).toString();
    const data = await this.checked(url);
    if (data.files?.length > 1)
      fail(
        "Hay más de un resultado para este trabajo en Drive. Se requiere revisión.",
        "needs_attention",
      );
    return data.files?.length
      ? this.verifyUpload(data.files[0].id, { jobId, folderId, size })
      : null;
  }
  async upload(
    filePath,
    { jobId, name, folderId, checkpoint = {}, onCheckpoint = async () => {} },
  ) {
    requireId(folderId);
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(jobId))
      fail("Identificador de trabajo inválido.", "validation", 400);
    const size = (await stat(filePath)).size;
    if (!size) fail("No se puede subir un archivo vacío.");
    const context = { jobId, folderId, size };
    if (checkpoint.sessionUrl) validSession(checkpoint.sessionUrl);
    if (checkpoint.size !== undefined && checkpoint.size !== size)
      fail(
        "El archivo cambió desde el inicio de la subida.",
        "upload_mismatch",
      );
    if (checkpoint.fileId) return this.verifyUpload(checkpoint.fileId, context);
    const reconciled = await this.reconcile(context);
    if (reconciled) return reconciled;
    let session = checkpoint.sessionUrl;
    let offset = 0;
    let targetFileId = checkpoint.targetFileId;
    if (targetFileId) requireId(targetFileId);
    const finish = async (file) => {
      if (!file.id) fail("Drive no confirmó el archivo creado.");
      const result = await this.verifyUpload(file.id, context);
      await onCheckpoint({
        targetFileId,
        sessionUrl: session,
        size,
        offset: size,
        fileId: file.id,
      });
      return result;
    };
    if (session) {
      const status = await this.request(session, {
        method: "PUT",
        redirect: "manual", // Drive's 308 Resume Incomplete is a protocol response, not navigation.
        headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
      });
      if (status.ok) return finish(await status.json());
      if (status.status === 308) offset = this.uploadOffset(status, size);
      else if (status.status === 404 || status.status === 410) {
        const found = await this.reconcile(context);
        if (found) return found;
        session = null;
      } else
        fail(
          `No se pudo recuperar la subida de Drive (HTTP ${status.status}).`,
        );
    }
    if (!session) {
      // A preallocated ID makes creation itself idempotent, including delayed search indexing.
      if (!targetFileId) {
        const allocated = await this.checked(
          `${API}/files/generateIds?count=1&space=drive&type=files`,
        );
        targetFileId = requireId(allocated.ids?.[0]);
      }
      await onCheckpoint({ targetFileId, size, offset: 0 });
      const response = await this.request(
        `${"https://www.googleapis.com/upload/drive/v3/files"}?uploadType=resumable&supportsAllDrives=true&fields=id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": String(size),
          },
          body: JSON.stringify({
            id: targetFileId,
            name: safeName(name),
            mimeType: "video/mp4",
            parents: [folderId],
            appProperties: { kavionJobId: jobId },
          }),
        },
      );
      if (response.status === 409) return finish({ id: targetFileId });
      if (!response.ok)
        fail(
          `No se pudo iniciar la subida de Drive (HTTP ${response.status}).`,
        );
      session = validSession(response.headers.get("location"));
      await onCheckpoint({
        targetFileId,
        sessionUrl: session,
        size,
        offset: 0,
      });
    }
    const file = await open(filePath, "r");
    try {
      while (offset < size) {
        const length = Math.min(8 * 1024 * 1024, size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead !== length)
          fail("El archivo cambió durante la subida.", "upload_mismatch");
        let response;
        try {
          response = await this.request(session, {
            method: "PUT",
            redirect: "manual",
            headers: {
              "Content-Type": "video/mp4",
              "Content-Length": String(length),
              "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}`,
            },
            body: buffer,
          });
        } catch (error) {
          const found = await this.reconcile(context).catch(() => null);
          if (found) return found;
          fail(
            "La conexión se interrumpió durante la subida. El próximo intento recuperará la sesión guardada.",
            "upload_interrupted",
          );
        }
        if (response.ok) return finish(await response.json());
        if (response.status !== 308)
          fail(
            `La subida se interrumpió (HTTP ${response.status}); podés reintentar para recuperarla.`,
            "upload_interrupted",
          );
        const next = this.uploadOffset(response, size);
        if (next <= offset || next > offset + length)
          fail(
            "Drive informó un avance de subida inválido.",
            "upload_interrupted",
          );
        offset = next;
        await onCheckpoint({ targetFileId, sessionUrl: session, size, offset });
      }
      const found = await this.reconcile(context);
      if (found) return found;
      fail(
        "Drive recibió los bytes pero no confirmó el archivo. Reintentá para consultar la sesión.",
        "upload_interrupted",
      );
    } finally {
      await file.close();
    }
  }
  uploadOffset(response, size) {
    const range = response.headers.get("range");
    if (!range) return 0;
    const match = range.match(/^bytes=0-(\d+)$/);
    const offset = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size)
      fail("Drive informó un rango de subida inválido.", "upload_interrupted");
    return offset;
  }
}
