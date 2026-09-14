/**
 * REST client. Auth rides on an HttpOnly cookie, so nothing sensitive is kept
 * in JavaScript; the X-WT-Client header is what satisfies the CSRF guard.
 */
export class Unauthorized extends Error {
  constructor() {
    super("Unauthorized");
    this.status = 401;
  }
}

async function request(method, url, body, opts = {}) {
  const headers = { "X-WT-Client": "1", ...(opts.headers || {}) };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: "same-origin" });
  if (res.status === 401) throw new Unauthorized();
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    // The caller often needs more than the sentence: "you must change your
    // password first" is a different situation from "you may not do that".
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

export const api = {
  config: () => request("GET", "/api/config"),
  login: (username, password) => request("POST", "/api/login", { username, password }),
  logout: () => request("POST", "/api/logout", {}),
  changePassword: (current, next) => request("POST", "/api/password", { current, next }),

  users: () => request("GET", "/api/users"),
  addUser: (user) => request("POST", "/api/users", user),
  resetUserPassword: (name, password) =>
    request("POST", `/api/users/${encodeURIComponent(name)}/password`, { password }),
  setUserRole: (name, role) => request("POST", `/api/users/${encodeURIComponent(name)}/role`, { role }),
  removeUser: (name) => request("DELETE", `/api/users/${encodeURIComponent(name)}`),
  profiles: () => request("GET", "/api/profiles"),

  listSessions: () => request("GET", "/api/sessions"),
  transcript: (id) => request("GET", `/api/sessions/${encodeURIComponent(id)}/transcript`),

  workspace: () => request("GET", "/api/workspace"),
  saveWorkspace: (workspace) => request("PUT", "/api/workspace", workspace),
  restoreWorkspace: () => request("POST", "/api/workspace/restore", {}),

  hosts: () => request("GET", "/api/hosts"),
  addHost: (host) => request("POST", "/api/hosts", host),
  renameHost: (id, name) => request("POST", `/api/hosts/${encodeURIComponent(id)}/rename`, { name }),
  removeHost: (id) => request("DELETE", `/api/hosts/${encodeURIComponent(id)}`),
  probeHost: (address, port) => request("POST", "/api/hosts/probe", { address, port }),

  history: (hostId) => request("GET", `/api/history?${q({ hostId })}`),
  reopenHistory: (entryId, hostId) =>
    request("POST", `/api/history/${encodeURIComponent(entryId)}/reopen`, { hostId }),
  deleteHistory: (entryId, hostId) =>
    request("DELETE", `/api/history/${encodeURIComponent(entryId)}?${q({ hostId })}`),
  createSession: (opts) => request("POST", "/api/sessions", opts),
  killSession: (id) => request("POST", `/api/sessions/${encodeURIComponent(id)}/kill`, {}),
  restartSession: (id) => request("POST", `/api/sessions/${encodeURIComponent(id)}/restart`, {}),
  renameSession: (id, title) => request("POST", `/api/sessions/${encodeURIComponent(id)}/rename`, { title }),
  updateSession: (id, patch) => request("POST", `/api/sessions/${encodeURIComponent(id)}/update`, patch),
  removeSession: (id) => request("DELETE", `/api/sessions/${encodeURIComponent(id)}`),

  listFiles: (path) => request("GET", `/api/files?${q({ path })}`),
  listDirs: (path) => request("GET", `/api/dirs?${q({ path })}`),
  mkdir: (path, name) => request("POST", "/api/files/mkdir", { path, name }),
  renameFile: (path, name) => request("POST", "/api/files/rename", { path, name }),
  deleteFile: (path) => request("POST", "/api/files/delete", { path }),
  downloadUrl: (path) => `/api/download?${q({ path })}`,

  gitStatus: (cwd) => request("GET", `/api/git/status?${q({ cwd })}`),
  gitBranches: (cwd) => request("GET", `/api/git/branches?${q({ cwd })}`),
  gitLog: (cwd, limit) => request("GET", `/api/git/log?${q({ cwd, limit })}`),

  ttsVoices: () => request("GET", "/api/tts/voices"),

  system: () => request("GET", "/api/system?logs=1"),
  health: () => request("GET", "/health"),
};

/**
 * Synthesised speech comes back as audio, not JSON, so it goes round the
 * request helper rather than through it.
 */
export async function ttsAudio(text, voiceId) {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "X-WT-Client": "1", "Content-Type": "application/json" },
    body: JSON.stringify({ text, voiceId }),
    credentials: "same-origin",
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch {}
    throw new Error(message);
  }
  return res.blob();
}

/** Upload with real progress events (fetch cannot report upload progress). */
export function uploadFile(dir, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?${q({ path: dir })}`);
    xhr.setRequestHeader("X-WT-Client", "1");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name).replace(/%20/g, " "));
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {}
      if (xhr.status === 401) return reject(new Unauthorized());
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.send(file);
  });
}
