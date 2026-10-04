import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await run(process.execPath, ["scripts/mirror-download.mjs", "--refresh"]);

if (process.argv.includes("--commit")) {
  await run("git", ["add", "mirror"]);
  const message = `chore(mirror): sync releases ${new Date().toISOString().slice(0, 10)}`;
  try { await run("git", ["commit", "-m", message]); } catch (error) {
    if (!String(error.message).includes("exited with 1")) throw error;
    console.log("Mirror is already up to date.");
  }
}
