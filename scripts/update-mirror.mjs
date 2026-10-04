import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const valueAfter = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
const mirrorDir = path.resolve(valueAfter("--mirror-dir") || process.env.MIRROR_REPOSITORY || path.join(projectRoot, "mirror"));
const shouldPush = args.includes("--push");

async function run(command, commandArgs, cwd = projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, MIRROR_ROOT: mirrorDir },
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await fs.mkdir(mirrorDir, { recursive: true });
await run(process.execPath, ["scripts/mirror-download.mjs", "--refresh"]);

if (shouldPush) {
  await run("git", ["add", "-A"], mirrorDir);
  const status = await new Promise((resolve, reject) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: mirrorDir, shell: process.platform === "win32" });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(output.trim()) : reject(new Error(`git status exited with ${code}`)));
  });
  if (status) {
    await run("git", ["commit", "-m", `chore: sync official releases ${new Date().toISOString().slice(0, 10)}`], mirrorDir);
    await run("git", ["push"], mirrorDir);
  } else {
    console.log("Mirror is already up to date.");
  }
}
