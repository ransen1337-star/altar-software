'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { catalog, publicCatalog } = require('./catalog.cjs');
const { createProviders } = require('./providers.cjs');
const { downloadFile } = require('./downloader.cjs');

const REGIONS = new Set(['auto', 'china', 'international']);
const LOG_LEVELS = new Set(['error', 'normal', 'verbose']);
const PACKAGE_KEYS = ['pip', 'npm', 'maven', 'cargo', 'go'];
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,80}$/;

function createInstallerService({ dataDir, platform, emit = () => {}, providers: providerOverride, downloader = downloadFile } = {}) {
  if (!path.isAbsolute(dataDir || '') || !platform) throw new Error('Absolute dataDir and platform are required');
  const providers = providerOverride || createProviders({
    packageVersionsImpl: platform.listPackageVersions?.bind(platform),
    mirrorBaseUrl: () => state.settings.mirrorBaseUrl,
  });
  const stateFile = path.join(dataDir, 'installer-state.json');
  let state = {
    installations: [], jobs: [],
    settings: { sourceRegion: 'auto', logLevel: 'normal', mirrorBaseUrl: process.env.DEV_ENV_MIRROR_BASE_URL || '', registryMirrors: Object.fromEntries(PACKAGE_KEYS.map(key => [key, false])) },
  };
  let saving = Promise.resolve();
  let mutation = Promise.resolve();
  let packageMutation = Promise.resolve();
  const controllers = new Map();
  const sourceConfirmations = new Map();
  let running = 0;

  const ready = fsp.readFile(stateFile, 'utf8').then(text => {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.installations)) state.installations = parsed.installations;
    if (Array.isArray(parsed.jobs)) state.jobs = parsed.jobs.map(job => ({
      ...job, status: ['running', 'awaiting-confirmation'].includes(job.status) ? 'paused' : job.status,
      stage: ['running', 'awaiting-confirmation'].includes(job.status) ? 'Interrupted; ready to resume' : job.stage,
    }));
    if (parsed.settings && REGIONS.has(parsed.settings.sourceRegion)) {
      state.settings = {
        sourceRegion: parsed.settings.sourceRegion,
        logLevel: LOG_LEVELS.has(parsed.settings.logLevel) ? parsed.settings.logLevel : 'normal',
        mirrorBaseUrl: typeof parsed.settings.mirrorBaseUrl === 'string' ? parsed.settings.mirrorBaseUrl : state.settings.mirrorBaseUrl,
        registryMirrors: Object.fromEntries(PACKAGE_KEYS.map(key => [key, parsed.settings.registryMirrors?.[key] === true])),
      };
    }
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });

  function save() {
    saving = saving.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true });
      const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await fsp.rename(temporary, stateFile);
    });
    return saving;
  }

  function serialized(action) {
    const next = mutation.then(action, action);
    mutation = next.catch(() => {});
    return next;
  }

  function serializedPackage(action) {
    const next = packageMutation.then(action, action);
    packageMutation = next.catch(() => {});
    return next;
  }

  function notify(type) { emit({ type }); }
  function jobView(job) {
    const { request, action, installationId, ...view } = job;
    const result = structuredClone(view);
    if (result.status === 'awaiting-confirmation') {
      result.status = 'paused';
      result.awaitingConfirmation = true;
    }
    return result;
  }
  function log(job, message) {
    const text = String(message).trim();
    if (!text) return;
    const level = /error|fail|fatal|拒绝|失败|错误/i.test(text) ? 'error' : 'verbose';
    if (state.settings.logLevel === 'error' && level !== 'error') return;
    const stamp = new Date().toISOString();
    job.logs.push(...text.split(/\r?\n/).filter(Boolean).slice(-8).map(line => `[${stamp}] [${level.toUpperCase()}] ${line}`));
    job.logs = job.logs.slice(-150);
    notify('jobs');
  }
  function setStage(job, stage, progress) {
    job.stage = stage;
    if (progress !== undefined) job.progress = Math.max(0, Math.min(100, Math.round(progress)));
    notify('jobs');
  }

  function assertId(id) {
    const entry = catalog.find(item => item.id === id);
    if (!entry) throw new Error('Unknown environment');
    return entry;
  }

  function validateRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid install request');
    const entry = assertId(input.id);
    const scope = input.scope || 'user';
    if (scope !== 'user' && scope !== 'system') throw new Error('Invalid install scope');
    if (scope === 'system' && ['rustup', 'msys2'].includes(entry.installMethod)) {
      throw new Error(`${entry.name} supports user installation only`);
    }
    const version = input.version || 'latest';
    if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Invalid version');
    if (entry.installMethod !== 'archive' && entry.installMethod !== 'msys2' && entry.installMethod !== 'winget' && version !== 'latest') {
      throw new Error('Version selection is unavailable for this installer');
    }
    const source = input.source || state.settings.sourceRegion;
    if (!REGIONS.has(source)) throw new Error('Invalid download region');
    let installPath = input.path || null;
    if (installPath) {
      if (!['archive', 'rustup', 'msys2'].includes(entry.installMethod)) throw new Error('Custom path is unsupported');
      if (scope === 'system') throw new Error('System installations use the managed ProgramData location');
      if (typeof installPath !== 'string' || !path.win32.isAbsolute(installPath) || !/^[A-Za-z]:\\/.test(installPath) || installPath.includes(';') || installPath.includes('\0')) {
        throw new Error('Install path must be an absolute local drive path');
      }
      installPath = path.win32.normalize(installPath);
      const parsed = path.win32.parse(installPath);
      if (installPath === parsed.root || installPath.length < parsed.root.length + 4) throw new Error('Install path is too broad');
    }
    const addToPath = input.addToPath === undefined ? true : input.addToPath;
    if (typeof addToPath !== 'boolean') throw new Error('Invalid PATH option');
    if (input.withTypeScript !== undefined && (entry.id !== 'node' || typeof input.withTypeScript !== 'boolean')) throw new Error('Invalid TypeScript option');
    return { id: entry.id, version, scope, path: installPath, addToPath, source, withTypeScript: input.withTypeScript === true };
  }

  async function externalInstallations() {
    const external = await platform.scanExternal(catalog);
    return external.filter(item => catalog.some(entry => entry.id === item.id)).map(item => ({
      id: item.id, version: item.version, path: item.path, source: item.manager && item.manager !== 'unknown' ? item.manager : 'external',
      managed: false, scope: item.scope, active: true, updateAvailable: false,
      installationId: `external:${crypto.createHash('sha256').update(`${item.id}\0${item.path}`).digest('hex').slice(0, 20)}`,
      manager: item.manager, packageId: item.packageId, updateable: item.updateable === true,
    }));
  }

  async function scan() {
    await ready;
    const installed = state.installations.map(item => ({
      id: item.id, version: item.version, path: item.path, source: item.source,
      managed: true, scope: item.scope, active: item.active, updateAvailable: false,
      installationId: item.installationId,
    }));
    const external = await externalInstallations();
    const knownPaths = new Set(installed.map(item => path.win32.normalize(item.path).toLowerCase()));
    return [...installed, ...external.filter(item => !knownPaths.has(path.win32.normalize(item.path).toLowerCase()))];
  }

  function pushJob(job) {
    state.jobs.push(job);
    void save(); notify('jobs');
    queueMicrotask(pump);
    return jobView(job);
  }

  function pump() {
    while (running < 3) {
      const job = state.jobs.find(item => item.status === 'queued' && !controllers.has(item.id));
      if (!job) return;
      job.status = 'running'; job.stage = 'Preparing';
      const controller = new AbortController();
      controllers.set(job.id, controller);
      running += 1; notify('jobs');
      void execute(job, controller.signal).then(async () => {
        if (!controller.signal.aborted && job.status === 'running') {
          job.status = 'completed'; job.progress = 100; job.stage = 'Completed';
        }
      }).catch(async error => {
        if (controller.signal.aborted || job.status === 'paused' || job.status === 'cancelled') return;
        job.status = 'failed'; job.error = error.message || String(error); job.stage = 'Failed';
        log(job, job.error);
      }).finally(async () => {
        controllers.delete(job.id); running -= 1;
        await save(); notify('jobs'); notify('scan');
        pump();
      });
    }
  }

  function check(signal) {
    if (signal.aborted) throw signal.reason || new Error('Operation cancelled');
  }

  async function run(file, args, { signal, env, onLog } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { env: env || process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
        const text = chunk.toString(); output += text.slice(0, 4096); onLog?.(text);
      });
      child.on('error', reject);
      child.on('close', code => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(new Error('Operation cancelled'));
        else if (code !== 0) reject(new Error(output.trim() || `${file} exited with ${code}`));
        else resolve(output);
      });
    });
  }

  function safeArchiveEntry(entry) {
    const normalized = entry.replace(/\\/g, '/');
    return normalized && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') && !normalized.includes('\0');
  }

  async function extractArchive(archive, destination, signal) {
    const output = await run('tar.exe', ['-tf', archive], { signal });
    const entries = output.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some(entry => !safeArchiveEntry(entry))) throw new Error('Archive contains unsafe paths');
    await fsp.mkdir(destination, { recursive: true });
    await run('tar.exe', ['-xf', archive, '-C', destination], { signal });
    const roots = await fsp.readdir(destination, { withFileTypes: true });
    return roots.length === 1 && roots[0].isDirectory() ? path.join(destination, roots[0].name) : destination;
  }

  function commandFor(id, root) {
    const entry = assertId(id);
    return path.win32.join(root, ...entry.command.split('/'));
  }

  function pathEntries(id, root, withTypeScript = false) {
    const entry = assertId(id);
    const command = commandFor(id, root);
    const directories = [path.win32.dirname(command)];
    if (id === 'node' && withTypeScript) directories.push(path.win32.join(root, 'typescript', 'node_modules', '.bin'));
    return [...new Set(directories)];
  }

  function versionArgs(id) {
    return ({ jdk: ['-version'], go: ['version'], kotlin: ['-version'], scala: ['-version'] })[id] || ['--version'];
  }

  async function installArchive(job, { id, version, scope, path: requestedPath, addToPath, source, withTypeScript }, signal, dependency = false) {
    const entry = assertId(id);
    const selected = version === 'latest' ? (await providers.versions(id))[0] : version;
    if (!selected) throw new Error('No release is available');
    if (state.installations.some(item => item.id === id && item.version === selected && item.scope === scope)) {
      if (dependency) return state.installations.find(item => item.id === id && item.version === selected && item.scope === scope);
      throw new Error('This version is already installed');
    }
    setStage(job, `Resolving ${id} ${selected}`, dependency ? 2 : 5);
    const release = await providers.resolve(id, selected, source);
    const installRoot = requestedPath || path.win32.join(platform.chooseRoot(scope, id), selected);
    if (state.installations.some(item => path.win32.normalize(item.path).toLowerCase() === path.win32.normalize(installRoot).toLowerCase())) {
      throw new Error('Installation path is already managed');
    }
    const work = path.join(dataDir, 'staging', job.id, `${id}-${selected}`);
    const archive = path.join(dataDir, 'downloads', id, `${selected}-${release.filename}`);
    await fsp.mkdir(work, { recursive: true });
    setStage(job, `Downloading ${id} ${selected}`, dependency ? 5 : 10);
    const downloaded = await downloader({
      urls: release.urls, destination: archive, hash: release.hash, algorithm: release.algorithm,
      signal, onProgress: progress => setStage(job, `Downloading ${id} ${selected}`, dependency ? 5 + progress * 12 : 10 + progress * 60),
      maxConnections: 4,
      onSourceFallback: async ({ failedUrl, nextUrl, error }) => {
        // Every fallback URL is resolved from a release feed and is checked
        // against the same official digest, so a transient source failure can
        // recover without leaving unattended jobs paused.
        log(job, `下载源失败，自动切换备用源：${failedUrl} -> ${nextUrl}（${error?.message || String(error)}）`);
        job.stage = '已自动切换备用源，继续下载';
        notify('jobs');
      },
    });
    check(signal);
    setStage(job, `Extracting ${id}`, dependency ? 18 : 73);
    const extracted = await extractArchive(archive, path.join(work, 'extracted'), signal);
    const stagedCommand = commandFor(id, extracted);
    const isMsys2 = entry.installMethod === 'msys2';
    if (isMsys2) {
      const pacman = path.win32.join(extracted, 'usr', 'bin', 'pacman.exe');
      if (!fs.existsSync(pacman)) throw new Error('MSYS2 base archive has no pacman executable');
    } else if (!fs.existsSync(stagedCommand)) throw new Error('Archive does not contain the expected executable');
    if (id === 'node' && withTypeScript) {
      const npmCli = path.win32.join(extracted, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(npmCli)) throw new Error('Node.js archive has no bundled npm');
      setStage(job, 'Installing TypeScript', 79);
      await run(stagedCommand, [npmCli, 'install', '--global', '--prefix', path.win32.join(extracted, 'typescript'), 'typescript@latest', '--ignore-scripts', '--no-audit'], {
        signal, onLog: text => log(job, text),
      });
    }
    check(signal);
    setStage(job, `Verifying ${id}`, dependency ? 20 : 82);
    const jdk = id === 'kotlin' || id === 'scala' ? state.installations.find(item => item.id === 'jdk' && item.active) : null;
    const env = jdk ? { ...process.env, JAVA_HOME: jdk.path, PATH: `${path.win32.join(jdk.path, 'bin')};${process.env.PATH}` } : undefined;
    if (!isMsys2) await platform.verify({ command: stagedCommand, args: versionArgs(id), expectedVersion: selected, env, signal });
    check(signal);
    let committed = false;
    try {
      await serialized(async () => {
        check(signal);
        setStage(job, `Committing ${id}`, dependency ? 23 : 90);
        await platform.commitDirectory({ source: extracted, destination: installRoot, scope });
        committed = true;
        check(signal);
        if (isMsys2) {
          await serializedPackage(() => platform.installPackage({
            manager: 'msys2', id, packageId: id === 'cpp' ? 'mingw-w64-x86_64-gcc' : 'lua',
            scope, signal, msysRoot: installRoot, onLog: text => log(job, text),
          }));
        }
        await platform.verify({ command: commandFor(id, installRoot), args: versionArgs(id), expectedVersion: isMsys2 ? undefined : selected, env, signal });
        const paths = addToPath ? pathEntries(id, installRoot, withTypeScript) : [];
        const prior = state.installations.filter(item => item.id === id && item.scope === scope && item.active);
        const removed = [];
        try {
          for (const old of prior) {
            await platform.removePaths({ scope, paths: old.paths || [] });
            removed.push(old);
          }
          if (paths.length) await platform.activatePaths({ scope, paths });
        } catch (error) {
          for (const old of removed) await platform.activatePaths({ scope, paths: old.paths || [] }).catch(() => {});
          throw error;
        }
        const record = {
          installationId: crypto.randomUUID(), id, version: selected, path: installRoot,
          source: /npmmirror|ustc|tuna|aliyun|cn-/i.test(downloaded.url || '') ? 'china mirror' : 'official',
          scope, active: !!addToPath, addToPath, paths, method: isMsys2 ? 'msys2' : 'archive', withTypeScript,
        };
        for (const old of prior) old.active = false;
        state.installations.push(record);
        await save(); notify('scan');
      });
    } catch (error) {
      if (committed) await platform.removeDirectory({ path: installRoot, scope }).catch(cleanup => log(job, `Rollback failed: ${cleanup.message}`));
      throw error;
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
    return state.installations.at(-1);
  }

  async function ensureJdk(job, request, signal) {
    const existing = state.installations.find(item => item.id === 'jdk' && item.active);
    if (existing) return existing;
    const external = (await externalInstallations()).find(item => item.id === 'jdk');
    if (external) return external;
    log(job, 'Installing required JDK first');
    return installArchive(job, { ...request, id: 'jdk', version: 'latest', path: null, addToPath: true, withTypeScript: false }, signal, true);
  }

  async function installWinget(job, request, signal) {
    const entry = assertId(request.id);
    setStage(job, `Installing ${entry.name} with WinGet`, 20);
    await serializedPackage(() => platform.installPackage({ manager: 'winget', id: entry.id, packageId: entry.packageId, version: request.version, scope: request.scope, signal, onLog: text => log(job, text) }));
    check(signal);
    const found = (await externalInstallations()).find(item => item.id === request.id && item.scope === request.scope && item.packageId === entry.packageId);
    if (!found) throw new Error('WinGet finished, but the installed environment could not be verified; inspect the installation before retrying');
    const record = {
      installationId: crypto.randomUUID(), id: request.id, version: found.version, path: found.path,
      source: 'winget', scope: request.scope, active: true, addToPath: false,
      paths: [], method: 'winget', packageId: entry.packageId,
    };
    state.installations.push(record);
    await save(); notify('scan');
  }

  async function execute(job, signal) {
    await ready;
    if (job.action === 'update-managed-winget') {
      const record = state.installations.find(item => item.installationId === job.installationId);
      if (!record || record.method !== 'winget') throw new Error('Managed package installation was not found');
      setStage(job, 'Updating through WinGet', 20);
      await serializedPackage(() => platform.updateExternal({ id: record.id, manager: 'winget', packageId: record.packageId, scope: record.scope, signal, onLog: text => log(job, text) }));
      return;
    }
    if (job.action === 'update-external') {
      const target = (await externalInstallations()).find(item => item.installationId === job.installationId);
      if (!target?.updateable) throw new Error('Original installer cannot be confirmed');
      setStage(job, 'Updating through original package manager', 20);
      await serializedPackage(() => platform.updateExternal({ id: target.id, manager: target.manager, packageId: target.packageId, scope: target.scope, signal, onLog: text => log(job, text) }));
      return;
    }
    const request = job.request;
    const entry = assertId(request.id);
    if (entry.dependency) await ensureJdk(job, request, signal);
    check(signal);
    if (entry.installMethod === 'archive' || entry.installMethod === 'msys2') await installArchive(job, request, signal);
    else if (entry.installMethod === 'winget') await installWinget(job, request, signal);
    else throw new Error(`${entry.name} installer is not ready`);
  }

  async function install(input) {
    await ready;
    const request = validateRequest(input);
    const job = {
      id: crypto.randomUUID(), languageId: request.id, version: request.version,
      status: 'queued', progress: 0, stage: 'Queued', logs: [], error: null,
      createdAt: new Date().toISOString(), action: 'install', request,
    };
    return pushJob(job);
  }

  async function update(installationId) {
    await ready;
    if (typeof installationId !== 'string') throw new Error('Invalid installation ID');
    const managed = state.installations.find(item => item.installationId === installationId);
    if (managed) {
      if (managed.method === 'winget') {
        return pushJob({ id: crypto.randomUUID(), languageId: managed.id, version: managed.version,
          status: 'queued', progress: 0, stage: 'Queued', logs: [], error: null,
          createdAt: new Date().toISOString(), action: 'update-managed-winget', installationId });
      }
      const available = await providers.versions(managed.id);
      const latest = available[0];
      if (!latest || (managed.version === latest || managed.version.startsWith(`${latest}.`))) throw new Error(`${managed.id} is already up to date`);
      return install({ id: managed.id, version: latest, scope: managed.scope, addToPath: managed.addToPath, withTypeScript: managed.withTypeScript });
    }
    const external = (await externalInstallations()).find(item => item.installationId === installationId);
    if (!external?.updateable) throw new Error('Original package manager is unknown; update manually');
    return pushJob({ id: crypto.randomUUID(), languageId: external.id, version: external.version,
      status: 'queued', progress: 0, stage: 'Queued', logs: [], error: null,
      createdAt: new Date().toISOString(), action: 'update-external', installationId });
  }

  async function activate(installationId) {
    await ready;
    const record = state.installations.find(item => item.installationId === installationId);
    if (!record) throw new Error('Only managed installations can be activated');
    if (!['archive', 'msys2'].includes(record.method)) throw new Error('This installer controls its own active version');
    return serialized(async () => {
      if (record.active) return { installationId };
      const prior = state.installations.filter(item => item.id === record.id && item.scope === record.scope && item.active);
      const removed = [];
      try {
        for (const old of prior) {
          await platform.removePaths({ scope: old.scope, paths: old.paths || [] });
          removed.push(old);
        }
        const paths = pathEntries(record.id, record.path, record.withTypeScript);
        await platform.activatePaths({ scope: record.scope, paths });
        for (const old of prior) old.active = false;
        record.active = true; record.paths = paths; record.addToPath = true;
        await save(); notify('scan');
        return { installationId };
      } catch (error) {
        for (const old of removed) await platform.activatePaths({ scope: old.scope, paths: old.paths || [] }).catch(() => {});
        throw error;
      }
    });
  }

  async function uninstall(installationId) {
    await ready;
    const record = state.installations.find(item => item.installationId === installationId);
    if (!record) throw new Error('Only installations tracked by this tool can be removed');
    return serialized(async () => {
      if (record.method === 'archive' || record.method === 'msys2') {
        if (record.paths?.length) await platform.removePaths({ scope: record.scope, paths: record.paths });
        try { await platform.removeDirectory({ path: record.path, scope: record.scope }); }
        catch (error) {
          if (record.paths?.length) await platform.activatePaths({ scope: record.scope, paths: record.paths }).catch(() => {});
          throw error;
        }
      } else if (record.method === 'winget') {
        await platform.uninstallPackage({ manager: 'winget', id: record.id, packageId: record.packageId, scope: record.scope });
      } else throw new Error('This installation cannot be removed automatically');
      state.installations = state.installations.filter(item => item !== record);
      await save(); notify('scan');
      return { installationId };
    });
  }

  async function transition(jobId, action) {
    await ready;
    const job = state.jobs.find(item => item.id === jobId);
    if (!job) throw new Error('Unknown task');
    if (action === 'pause') {
      if (!['queued', 'running'].includes(job.status)) throw new Error('Task cannot be paused');
      job.status = 'paused'; job.stage = 'Paused';
      controllers.get(jobId)?.abort();
    } else if (action === 'resume') {
      if (job.status !== 'paused') throw new Error('Task is not paused');
      job.status = 'queued'; job.stage = 'Queued'; job.error = null;
      queueMicrotask(pump);
    } else {
      if (!['queued', 'running', 'paused', 'awaiting-confirmation'].includes(job.status)) throw new Error('Task cannot be cancelled');
      job.status = 'cancelled'; job.stage = 'Cancelled';
      sourceConfirmations.get(jobId)?.(false);
      sourceConfirmations.delete(jobId);
      controllers.get(jobId)?.abort();
    }
    await save(); notify('jobs');
    return jobView(job);
  }

  async function confirmSource(jobId, accept) {
    await ready;
    if (typeof jobId !== 'string' || typeof accept !== 'boolean') throw new Error('Invalid source confirmation');
    const job = state.jobs.find(item => item.id === jobId);
    if (!job || job.status !== 'awaiting-confirmation' || !sourceConfirmations.has(jobId)) {
      throw new Error('This task is not waiting for source confirmation');
    }
    sourceConfirmations.get(jobId)(accept);
    sourceConfirmations.delete(jobId);
    return jobView(job);
  }

  async function removeJob(jobId) {
    await ready;
    const index = state.jobs.findIndex(item => item.id === jobId);
    if (index < 0) throw new Error('Unknown task');
    const job = state.jobs[index];
    if (!['failed', 'cancelled', 'paused', 'awaiting-confirmation'].includes(job.status)) throw new Error('Only stopped tasks can be deleted');
    if (job.status === 'awaiting-confirmation') sourceConfirmations.get(jobId)?.(false);
    sourceConfirmations.delete(jobId);
    controllers.get(jobId)?.abort();
    job.status = 'cancelled';
    state.jobs.splice(index, 1);
    await save();
    notify('jobs');
    return { id: jobId };
  }

  async function setSettings(input) {
    await ready;
    if (!input || typeof input !== 'object' || !REGIONS.has(input.sourceRegion)) throw new Error('Invalid source region');
    const logLevel = input.logLevel || state.settings.logLevel;
    if (!LOG_LEVELS.has(logLevel)) throw new Error('Invalid log level');
    const mirrors = input.registryMirrors;
    if (!mirrors || typeof mirrors !== 'object' || PACKAGE_KEYS.some(key => typeof mirrors[key] !== 'boolean')) throw new Error('Invalid package mirror selection');
    const mirrorBaseUrl = typeof input.mirrorBaseUrl === 'string' ? input.mirrorBaseUrl.trim().replace(/\/+$/, '') : state.settings.mirrorBaseUrl;
    if (mirrorBaseUrl && !/^https:\/\//i.test(mirrorBaseUrl)) throw new Error('镜像仓库地址必须使用 HTTPS');
    const next = { sourceRegion: input.sourceRegion, logLevel, mirrorBaseUrl, registryMirrors: Object.fromEntries(PACKAGE_KEYS.map(key => [key, mirrors[key]])) };
    if (PACKAGE_KEYS.some(key => next.registryMirrors[key] !== state.settings.registryMirrors[key])) {
      await platform.applyRegistryMirrors({ mirrors: next.registryMirrors });
    }
    state.settings = next;
    await save(); notify('settings');
    return structuredClone(next);
  }

  return {
    catalog: async () => structuredClone(publicCatalog),
    versions: async (id, source = 'auto') => { await ready; assertId(id); return providers.versions(id, source); },
    scan, jobs: async () => { await ready; return state.jobs.map(jobView).reverse(); },
    install, activate, uninstall, update,
    pause: id => transition(id, 'pause'), resume: id => transition(id, 'resume'), cancel: id => transition(id, 'cancel'), confirmSource, removeJob,
    getSettings: async () => { await ready; return structuredClone(state.settings); }, setSettings,
  };
}

module.exports = { createInstallerService };
