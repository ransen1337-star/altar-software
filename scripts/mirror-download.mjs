import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProviders } from "../electron/installer/providers.cjs";
import { catalog } from "../electron/installer/catalog.cjs";
import { downloadFile } from "../electron/installer/downloader.cjs";

const root = path.resolve(process.env.MIRROR_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mirror"));
const manifestPath = path.join(root, "manifest.json");
const providers = createProviders();

async function readManifest() {
  try { return JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch { return { generatedAt: null, artifacts: [], unsupported: [] }; }
}

function normalizeArtifact(artifact) {
  artifact.urls = artifact.urls.map(url => url.replace(
    "https://npmmirror.com/mirrors/node/",
    "https://cdn.npmmirror.com/binaries/node/",
  ));
  if (artifact.id === "node") {
    const cdnUrl = `https://cdn.npmmirror.com/binaries/node/v${artifact.version}/${artifact.filename}`;
    artifact.urls = [...new Set([...artifact.urls, cdnUrl])];
  }
  if (artifact.id === "go") {
    const ustcUrl = `https://mirrors.ustc.edu.cn/golang/${artifact.filename}`;
    artifact.urls = [...new Set([...artifact.urls, ustcUrl])];
  }
  if (artifact.id === "jdk") {
    const releaseUrl = artifact.urls.find(url => url.includes("github.com/adoptium/"));
    const match = releaseUrl?.match(/releases\/download\/jdk-([^/]+)\//i) || releaseUrl?.match(/releases\/download\/(jdk[^/]+)\//i);
    const version = (match?.[1]?.replace(/^jdk/, "").replace(/%2B1$/i, "") || artifact.filename.match(/jdk_x64_windows_hotspot_([^_]+)\.zip/i)?.[1]);
    if (version) {
      const apiUrl = `https://api.adoptium.net/v3/binary/version/${version}/windows/x64/jdk/hotspot/normal/eclipse`;
      artifact.urls = [...new Set([...artifact.urls, apiUrl])];
    }
  }
  if (artifact.status === "failed") artifact.status = "pending";
  delete artifact.error;
  return artifact;
}

async function save(manifest) {
  manifest.generatedAt = new Date().toISOString();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function resolveArtifacts(manifest) {
  const artifacts = [];
  const unsupported = [];
  for (const entry of catalog) {
    if (entry.installMethod === "winget") {
      unsupported.push({ id: entry.id, reason: "WinGet package; no portable archive to mirror", packageId: entry.packageId });
      continue;
    }
    const versions = await providers.versions(entry.id, "auto");
    for (const version of versions) {
      const release = await providers.resolve(entry.id, version, "auto");
      artifacts.push({
        id: entry.id,
        version,
        filename: release.filename,
        urls: release.urls,
        hash: release.hash,
        algorithm: release.algorithm,
        archive: release.archive,
        relativePath: path.posix.join(entry.id, version, release.filename),
        status: "pending",
      });
    }
  }
  manifest.artifacts = artifacts;
  manifest.unsupported = unsupported;
  await save(manifest);
  return manifest;
}

async function downloadArtifacts(manifest) {
  let completed = 0;
  let failed = 0;
  let lastShown = -1;
  for (const artifact of manifest.artifacts) {
    const destination = path.join(root, artifact.relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (artifact.status === "completed") { completed += 1; continue; }
    process.stdout.write(`[${completed}/${manifest.artifacts.length}] ${artifact.id} ${artifact.version} ${artifact.filename}\n`);
    try {
      const result = await downloadFile({
        urls: artifact.urls,
        destination,
        hash: artifact.hash,
        algorithm: artifact.algorithm,
        maxConnections: 4,
        onProgress: progress => {
          const percent = Math.floor(progress * 100);
          if (percent !== lastShown) {
            lastShown = percent;
            process.stdout.write(`\r  ${percent}%`);
          }
        },
        onSourceFallback: async ({ failedUrl, nextUrl, error }) => {
          process.stdout.write(`\n  fallback ${failedUrl} -> ${nextUrl}: ${error?.message || error}\n`);
        },
      });
      artifact.status = "completed";
      artifact.downloadedUrl = result.url;
      artifact.size = result.size;
      artifact.completedAt = new Date().toISOString();
      completed += 1;
      process.stdout.write("\n");
      lastShown = -1;
    } catch (error) {
      artifact.status = "failed";
      artifact.error = error.message || String(error);
      await save(manifest);
      failed += 1;
      process.stdout.write(`\n  failed: ${artifact.error}\n`);
    }
    await save(manifest);
  }
  if (failed) throw new Error(`${failed} artifact(s) failed; rerun the mirror command to retry them`);
}

const existing = await readManifest();
const prior = new Map(existing.artifacts.map(artifact => [`${artifact.id}@${artifact.version}`, artifact]));
existing.artifacts = existing.artifacts.map(normalizeArtifact);
const shouldRefresh = process.argv.includes("--refresh") || !existing.artifacts.length;
const manifest = shouldRefresh ? await resolveArtifacts(existing) : existing;
if (shouldRefresh) {
  for (const artifact of manifest.artifacts) {
    const old = prior.get(`${artifact.id}@${artifact.version}`);
    if (!old || old.hash !== artifact.hash || old.filename !== artifact.filename) continue;
    const destination = path.join(root, artifact.relativePath);
    try { await fs.access(destination); } catch { continue; }
    Object.assign(artifact, {
      status: old.status === "completed" ? "completed" : "pending",
      downloadedUrl: old.downloadedUrl,
      size: old.size,
      completedAt: old.completedAt,
    });
  }
  await save(manifest);
} else if (existing.artifacts.length) await save(existing);
if (process.argv.includes("--manifest-only")) {
  console.log(`Wrote ${manifest.artifacts.length} artifacts to ${manifestPath}`);
  console.log(`Unsupported WinGet packages: ${manifest.unsupported.length}`);
} else {
  await downloadArtifacts(manifest);
  console.log(`Mirror complete: ${manifest.artifacts.length} artifacts in ${root}`);
}
