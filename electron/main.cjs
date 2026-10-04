const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { createInstallerService } = require("./installer/index.cjs");
const { createWindowsPlatform } = require("./platform/index.cjs");

app.setName("Altar");

// Keep Chromium's text and color rasterization stable on Windows high-DPI displays.
app.commandLine.appendSwitch("force-color-profile", "srgb");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("disable-lcd-text");

const developmentUrl = process.env.DEV_SERVER_URL;
const localRoot = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DevEnvManager");
const singleInstance = app.requestSingleInstanceLock();
let mainWindow;
let service;

if (!singleInstance) app.quit();

function verifyRenderer(event) {
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) throw new Error("Unknown IPC sender");
  const sender = new URL(frameUrl);
  if (developmentUrl && sender.origin === new URL(developmentUrl).origin) return;
  if (!developmentUrl && sender.protocol === "file:" && decodeURIComponent(sender.pathname).includes(app.getAppPath())) return;
  throw new Error("IPC sender is not the application UI");
}

function handle(name, fn) {
  ipcMain.handle(`dev-env:${name}`, async (event, ...args) => {
    verifyRenderer(event);
    return fn(...args);
  });
}

function registerHandlers() {
  for (const [channel, method] of Object.entries({
    catalog: "catalog",
    scan: "scan",
    versions: "versions",
    jobs: "jobs",
    install: "install",
    activate: "activate",
    uninstall: "uninstall",
    update: "update",
    pause: "pause",
    resume: "resume",
    cancel: "cancel",
    "confirm-source": "confirmSource",
    "remove-job": "removeJob",
    "get-settings": "getSettings",
    "set-settings": "setSettings",
  })) {
    handle(channel, (...args) => service[method](...args));
  }

  handle("pick-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("window-state", () => ({
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
  }));
  handle("window-action", (action) => {
    if (action === "minimize") mainWindow.minimize();
    else if (action === "maximize") mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (action === "close") mainWindow.close();
    else throw new Error("Unsupported window action");
    return { isMaximized: mainWindow.isMaximized(), isFullscreen: mainWindow.isFullScreen() };
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Altar",
    icon: path.join(__dirname, "..", "public", "altar-logo.png"),
    width: 1240,
    height: 800,
    minWidth: 640,
    minHeight: 540,
    backgroundColor: "#121212",
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).protocol === "https:") shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (developmentUrl && new URL(url).origin === new URL(developmentUrl).origin) return;
    event.preventDefault();
    if (new URL(url).protocol === "https:") shell.openExternal(url);
  });
  mainWindow.on("closed", () => { mainWindow = null; });

  if (developmentUrl) await mainWindow.loadURL(developmentUrl);
  else await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.on("window-all-closed", () => app.quit());

app.whenReady().then(async () => {
  if (process.platform !== "win32") throw new Error("This version supports Windows only");
  fs.mkdirSync(localRoot, { recursive: true });
  const emit = (change) => mainWindow?.webContents.send("dev-env:change", change);
  const platform = createWindowsPlatform({ dataDir: localRoot, emit });
  service = createInstallerService({ dataDir: localRoot, platform, emit });
  registerHandlers();
  await createWindow();
}).catch((error) => {
  dialog.showErrorBox("启动失败", error.stack || String(error));
  app.quit();
});
