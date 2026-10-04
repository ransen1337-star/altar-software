import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electron = require("electron");
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");

async function availablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error("No free development port found");
}

const port = await availablePort(5173);
const url = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let desktop;
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill();
  vite.kill();
  process.exitCode = code;
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
vite.on("exit", (code) => stop(code || 1));

for (let attempt = 0; attempt < 120; attempt += 1) {
  if (vite.exitCode !== null) throw new Error("Vite stopped before Electron started");
  try {
    const response = await fetch(url);
    if (response.ok) break;
  } catch {
    // Vite is still starting.
  }
  if (attempt === 119) throw new Error(`Vite did not start at ${url}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

const env = { ...process.env, DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
desktop = spawn(electron, [root], { cwd: root, stdio: "inherit", env });
desktop.on("exit", (code) => stop(code || 0));
