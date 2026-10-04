const { contextBridge, ipcRenderer } = require("electron");

const call = (name, ...args) => ipcRenderer.invoke(`dev-env:${name}`, ...args);

contextBridge.exposeInMainWorld("devEnv", Object.freeze({
  catalog: () => call("catalog"),
  scan: () => call("scan"),
  versions: (id, source) => call("versions", id, source),
  jobs: () => call("jobs"),
  install: (request) => call("install", request),
  activate: (installationId) => call("activate", installationId),
  uninstall: (installationId) => call("uninstall", installationId),
  update: (installationId) => call("update", installationId),
  pause: (jobId) => call("pause", jobId),
  resume: (jobId) => call("resume", jobId),
  cancel: (jobId) => call("cancel", jobId),
  confirmSource: (jobId, accept) => call("confirm-source", jobId, accept),
  removeJob: (jobId) => call("remove-job", jobId),
  getSettings: () => call("get-settings"),
  setSettings: (patch) => call("set-settings", patch),
  pickDirectory: () => call("pick-directory"),
  windowAction: (action) => call("window-action", action),
  windowState: () => call("window-state"),
  onChange: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Expected a listener");
    const handle = (_event, change) => listener(change);
    ipcRenderer.on("dev-env:change", handle);
    return () => ipcRenderer.removeListener("dev-env:change", handle);
  },
}));
