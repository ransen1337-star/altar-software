'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { catalog } = require('../installer/catalog.cjs');
const APP_NAME = 'DevEnvManager';
const WINGET_PACKAGES = new Map(catalog.filter(item => item.installMethod === 'winget')
  .map(item => [item.id, item.packageId]));
const ALLOWED_ENV_KEYS = new Set([
  'JAVA_HOME', 'GOROOT', 'GOPATH', 'DOTNET_ROOT', 'R_HOME',
  'CARGO_HOME', 'RUSTUP_HOME', 'DART_SDK', 'MAVEN_HOME',
  'PIP_INDEX_URL', 'NPM_CONFIG_REGISTRY', 'CARGO_REGISTRIES_CRATES_IO_INDEX',
  'GOPROXY', 'MAVEN_ARGS',
]);
const COMMANDS = Object.freeze({
  python: [{ name: 'python.exe', args: ['--version'] }, { name: 'py.exe', args: ['--version'] }],
  node: [{ name: 'node.exe', args: ['--version'] }],
  jdk: [{ name: 'javac.exe', args: ['-version'] }, { name: 'java.exe', args: ['-version'] }],
  go: [{ name: 'go.exe', args: ['version'] }],
  rust: [{ name: 'rustc.exe', args: ['--version'] }],
  dotnet: [{ name: 'dotnet.exe', args: ['--version'] }],
  cpp: [{ name: 'gcc.exe', args: ['--version'] }, { name: 'cl.exe', args: [] }],
  php: [{ name: 'php.exe', args: ['--version'] }],
  ruby: [{ name: 'ruby.exe', args: ['--version'] }],
  dart: [{ name: 'dart.exe', args: ['--version'] }],
  r: [{ name: 'R.exe', args: ['--version'] }],
  julia: [{ name: 'julia.exe', args: ['--version'] }],
  perl: [{ name: 'perl.exe', args: ['-v'] }],
  lua: [{ name: 'lua.exe', args: ['-v'] }],
  kotlin: [{ name: 'kotlinc.bat', args: ['-version'] }],
  scala: [{ name: 'scala.bat', args: ['-version'] }],
});
const DISPLAY_NAMES = Object.freeze({
  python: /\bpython\b/i,
  node: /\bnode\.?js\b/i,
  jdk: /\b(jdk|java development kit|temurin)\b/i,
  go: /\b(go programming language|golang)\b/i,
  rust: /\b(rustup|rust toolchain)\b/i,
  dotnet: /\b(\.net sdk|dotnet sdk)\b/i,
  cpp: /\b(msys2|visual studio .*build tools|mingw)\b/i,
  php: /\bphp\b/i,
  ruby: /\b(ruby|rubyinstaller)\b/i,
  dart: /\bdart sdk\b/i,
  r: /^R for Windows\b/i,
  julia: /\bjulia\b/i,
  perl: /\b(strawberry perl|activeperl)\b/i,
  lua: /\blua\b/i,
  kotlin: /\bkotlin\b/i,
  scala: /\bscala\b/i,
});
const MANAGER_PACKAGES = Object.freeze({
  scoop: { python: 'python', node: 'nodejs', jdk: 'temurin-jdk', go: 'go', rust: 'rustup', dotnet: 'dotnet-sdk', cpp: 'gcc', php: 'php', ruby: 'ruby', dart: 'dart', r: 'r', julia: 'julia', perl: 'perl', lua: 'lua', kotlin: 'kotlin', scala: 'scala' },
  choco: { python: 'python', node: 'nodejs', jdk: 'temurin', go: 'golang', rust: 'rustup.install', dotnet: 'dotnet-sdk', cpp: 'msys2', php: 'php', ruby: 'ruby', dart: 'dart-sdk', r: 'r.project', julia: 'julia', perl: 'strawberryperl', lua: 'lua', kotlin: 'kotlin-compiler', scala: 'scala' },
});

function normalizePathEntry(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/^"|"$/g, '').replace(/\//g, '\\');
  return trimmed.replace(/\\+$/, '').toLowerCase();
}

function splitPath(value) {
  return String(value || '').split(';').map(item => item.trim()).filter(Boolean);
}

function previewPathValue(current, add = [], remove = []) {
  const removed = new Set(remove.map(normalizePathEntry));
  const seen = new Set();
  const next = [];
  for (const item of [...splitPath(current), ...add]) {
    const key = normalizePathEntry(item);
    if (!key || removed.has(key) || seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next.join(';');
}

function assertScope(scope) {
  if (scope !== 'user' && scope !== 'system') throw new Error('Scope must be user or system');
}

function assertPathValue(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes(';')) {
    throw new Error('Invalid PATH entry');
  }
  if (!path.win32.isAbsolute(value) || !/^[a-zA-Z]:\\/.test(value)) {
    throw new Error('PATH entry must be an absolute local drive path');
  }
  return path.win32.normalize(value);
}

function inside(root, target) {
  const relative = path.win32.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative);
}

function validateManagedDestination(target, scope, root) {
  assertScope(scope);
  const resolved = assertPathValue(target);
  if (scope === 'system' && !inside(root, resolved)) {
    throw new Error('System installation must stay inside the managed ProgramData directory');
  }
  const parsed = path.win32.parse(resolved);
  if (resolved === parsed.root || resolved.length < parsed.root.length + 4) {
    throw new Error('Installation directory is too broad');
  }
  const restricted = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData'];
  if (restricted.some(part => {
    const parent = path.win32.join(parsed.root, part).toLowerCase();
    const targetLower = resolved.toLowerCase();
    return targetLower === parent || targetLower.startsWith(`${parent}\\`);
  })) {
    throw new Error('Installation directory is a protected parent directory');
  }
  return resolved;
}

async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, file);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let spawnFile = file;
    let spawnArgs = args;
    if (/\.(?:cmd|bat)$/i.test(file)) {
      const commandParts = [file, ...args].map(value => String(value));
      if (commandParts.some(value => /[%!^&|<>]/.test(value))) {
        return reject(new Error('Unsafe batch command'));
      }
      const quote = value => `"${value.replace(/"/g, '\\"')}"`;
      spawnFile = 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', `${quote(file)}${args.length ? ` ${args.map(quote).join(' ')}` : ''}`];
    }
    const child = spawn(spawnFile, spawnArgs, {
      windowsHide: true, shell: false, env: options.env || process.env,
      cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = options.maxOutput || 1024 * 1024;
    const timer = options.timeout ? setTimeout(() => child.kill(), options.timeout) : null;
    const abort = () => child.kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > limit) child.kill();
      options.onLog?.(chunk.toString());
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > limit) child.kill();
      options.onLog?.(chunk.toString());
    });
    child.on('error', reject);
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return reject(new Error('Operation cancelled'));
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error((stderr || stdout || `${file} exited with ${code}`).trim()));
    });
  });
}

function psQuote(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function encodedPowerShell(script) { return Buffer.from(script, 'utf16le').toString('base64'); }

async function assertNoLinks(root) {
  const queue = [root];
  while (queue.length) {
    const item = queue.pop();
    const info = await fsp.lstat(item);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in installation staging: ${item}`);
    if (info.isDirectory()) {
      for (const child of await fsp.readdir(item)) queue.push(path.join(item, child));
    }
  }
}

function parseVersion(output) {
  const match = String(output).match(/(?:\d+\.){1,3}\d+(?:[-+][\w.]+)?/);
  return match ? match[0] : null;
}

function guessScope(file) {
  const lower = file.toLowerCase();
  const home = (process.env.USERPROFILE || os.homedir()).toLowerCase();
  return lower.startsWith(home + '\\') ? 'user' : 'system';
}

function managerForPath(id, file, knownPackages, expectedWingetId) {
  const lower = file.toLowerCase().replace(/\//g, '\\');
  const scoopPackage = MANAGER_PACKAGES.scoop[id];
  if (scoopPackage && (lower.includes('\\scoop\\shims\\') || lower.includes(`\\scoop\\apps\\${scoopPackage.toLowerCase()}\\`)) && knownPackages.scoop.has(scoopPackage.toLowerCase())) {
    return { manager: 'scoop', packageId: scoopPackage, updateable: true };
  }
  const chocoPackage = MANAGER_PACKAGES.choco[id];
  if (chocoPackage && lower.includes('\\chocolatey\\bin\\') && knownPackages.choco.has(chocoPackage.toLowerCase())) {
    return { manager: 'choco', packageId: chocoPackage, updateable: true };
  }
  if (lower.includes('\\microsoft\\winget\\packages\\')) {
    if (expectedWingetId && knownPackages.winget.has(expectedWingetId) && lower.includes(`\\${expectedWingetId.toLowerCase()}_`)) {
      return { manager: 'winget', packageId: expectedWingetId, updateable: true };
    }
  }
  return { manager: 'unknown', updateable: false };
}

function createWindowsPlatform({ dataDir, emit = () => {}, processRunner = runProcess, helperInvoker } = {}) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Absolute dataDir is required');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
  const userRoot = path.win32.join(local, APP_NAME, 'environments');
  const systemRoot = path.win32.join(programData, APP_NAME, 'environments');
  const systemStateDir = path.win32.join(programData, APP_NAME);
  const helperFile = path.join(__dirname, 'elevated-helper.ps1');
  const ownedPathsFile = path.join(dataDir, 'owned-paths.json');
  const systemOwnedPathsFile = path.win32.join(systemStateDir, 'owned-paths.json');
  const ownedDirectoriesFile = path.join(dataDir, 'owned-directories.json');
  const systemOwnedDirectoriesFile = path.win32.join(systemStateDir, 'owned-directories.json');
  const ownedEnvFile = path.join(dataDir, 'owned-env.json');
  const systemOwnedEnvFile = path.win32.join(systemStateDir, 'owned-env.json');
  const mirrorStateFile = path.join(dataDir, 'mirror-state.json');
  let mutation = Promise.resolve();

  function serialized(action) {
    const next = mutation.then(action, action);
    mutation = next.catch(() => {});
    return next;
  }

  function stateFile(scope, userFile, systemFile) {
    return scope === 'system' ? systemFile : userFile;
  }

  function backupDir(scope) {
    return path.win32.join(scope === 'system' ? systemStateDir : dataDir, 'backups');
  }

  async function readOwned(scope, userFile, systemFile, fallback) {
    const file = stateFile(scope, userFile, systemFile);
    if (scope === 'system') return (await invokeHelper('read-state', { file }, scope)) ?? fallback;
    return readJson(file, fallback);
  }

  async function writeOwned(scope, userFile, systemFile, value) {
    const file = stateFile(scope, userFile, systemFile);
    if (scope === 'system') return invokeHelper('write-state', { file, value }, scope);
    return atomicJson(file, value);
  }

  async function invokeHelper(action, payload, scope = 'user', signal) {
    assertScope(scope);
    if (helperInvoker) return helperInvoker(action, payload, scope, signal);
    const resultFile = path.join(os.tmpdir(), `dev-env-${crypto.randomUUID()}.json`);
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const command = `& ${psQuote(helperFile)} -Action ${psQuote(action)} -Payload ${psQuote(encodedPayload)} -ResultFile ${psQuote(resultFile)}`;
    const inner = encodedPowerShell(command);
    let script = command;
    if (scope === 'system' && action !== 'read-env' && action !== 'read-state') {
      script = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${inner}'); exit $p.ExitCode`;
    }
    try {
      const completed = await processRunner('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedPowerShell(script),
      ], { signal, timeout: 15 * 60 * 1000, allowFailure: true });
      const result = await readJson(resultFile, null);
      if (!result) throw new Error((completed.stderr || completed.stdout || 'Elevated operation failed or UAC was cancelled').trim());
      if (!result.ok) throw new Error(result.error || 'Platform operation failed');
      if (completed.code !== 0) throw new Error('Platform helper exited unexpectedly');
      return result.value;
    } finally {
      await fsp.rm(resultFile, { force: true }).catch(() => {});
    }
  }

  function chooseRoot(scope, id) {
    assertScope(scope);
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid environment ID');
    return path.win32.join(scope === 'system' ? systemRoot : userRoot, id);
  }

  async function previewPathChange({ scope = 'user', add = [], remove = [] } = {}) {
    assertScope(scope);
    add = add.map(assertPathValue);
    remove = remove.map(assertPathValue);
    const owned = await readOwned(scope, ownedPathsFile, systemOwnedPathsFile, { user: [], system: [] });
    const registered = new Set((owned[scope] || []).map(normalizePathEntry));
    const effectiveRemove = remove.filter(item => registered.has(normalizePathEntry(item)));
    const current = await invokeHelper('read-env', { scope, name: 'Path' }, scope);
    return { scope, previous: current.value || '', next: previewPathValue(current.value, add, effectiveRemove), add, remove: effectiveRemove };
  }

  async function applyPath({ scope = 'user', add = [], remove = [] } = {}) {
    return serialized(async () => {
      assertScope(scope);
      add = add.map(assertPathValue);
      remove = remove.map(assertPathValue);
      if (scope === 'system' && add.some(item => !inside(systemRoot, item))) {
        throw new Error('System PATH can only include managed installation paths');
      }
      const owned = await readOwned(scope, ownedPathsFile, systemOwnedPathsFile, { user: [], system: [] });
      const registered = new Set((owned[scope] || []).map(normalizePathEntry));
      const effectiveRemove = remove.filter(item => registered.has(normalizePathEntry(item)));
      const result = await invokeHelper('path-change', {
        scope, add, remove: effectiveRemove, backupDir: backupDir(scope),
      }, scope);
      const next = (owned[scope] || []).filter(item => !effectiveRemove.some(removed => normalizePathEntry(removed) === normalizePathEntry(item)));
      const before = new Set(splitPath(result.previous).map(normalizePathEntry));
      for (const item of add) {
        if (!before.has(normalizePathEntry(item)) && !next.some(entry => normalizePathEntry(entry) === normalizePathEntry(item))) next.push(item);
      }
      owned[scope] = next;
      try { await writeOwned(scope, ownedPathsFile, systemOwnedPathsFile, owned); }
      catch (error) {
        await invokeHelper('restore-env', { scope, name: 'Path', backupFile: result.backupFile }, scope);
        throw error;
      }
      emit('platform:path-changed', { scope, previous: result.previous, next: result.next });
      return result;
    });
  }

  function activatePaths({ scope = 'user', paths = [] } = {}) {
    return applyPath({ scope, add: paths });
  }

  function removePaths({ scope = 'user', paths = [] } = {}) {
    return applyPath({ scope, remove: paths });
  }

  async function applyEnvironment({ scope = 'user', changes = {} } = {}) {
    return serialized(async () => {
      assertScope(scope);
      const entries = Object.entries(changes);
      if (!entries.length) return [];
      for (const [name, value] of entries) {
        if (!ALLOWED_ENV_KEYS.has(name) || (value !== null && typeof value !== 'string')) throw new Error(`Unsupported environment variable: ${name}`);
        if (scope === 'system' && value && !inside(systemRoot, value)) throw new Error('System variable must refer to a managed installation');
      }
      const owned = await readOwned(scope, ownedEnvFile, systemOwnedEnvFile, { user: {}, system: {} });
      for (const [name, value] of entries) {
        if (value === null && !Object.hasOwn(owned[scope] || {}, name)) {
          throw new Error(`Cannot remove an environment variable not owned by this tool: ${name}`);
        }
      }
      const results = [];
      try {
        for (const [name, value] of entries) {
          const result = await invokeHelper('env-change', { scope, name, value, backupDir: backupDir(scope) }, scope);
          results.push({ ...result, name });
        }
        owned[scope] ||= {};
        for (const [name, value] of entries) {
          if (value === null) delete owned[scope][name];
          else owned[scope][name] = value;
        }
        await writeOwned(scope, ownedEnvFile, systemOwnedEnvFile, owned);
      } catch (error) {
        for (const result of results.reverse()) {
          await invokeHelper('restore-env', { scope, name: result.name, backupFile: result.backupFile }, scope).catch(() => {});
        }
        throw error;
      }
      return results;
    });
  }

  async function commitDirectory({ source, destination, scope = 'user' }) {
    return serialized(async () => {
      assertScope(scope);
      const target = validateManagedDestination(destination, scope, systemRoot);
      const staged = assertPathValue(source);
      if (!inside(path.win32.normalize(dataDir), staged)) throw new Error('Staging must be inside application data');
      await assertNoLinks(staged);
      const owned = await readOwned(scope, ownedDirectoriesFile, systemOwnedDirectoriesFile, { user: [], system: [] });
      if (fs.existsSync(target) && !(owned[scope] || []).some(item => normalizePathEntry(item) === normalizePathEntry(target))) {
        throw new Error('Destination exists and was not installed by this tool');
      }
      await invokeHelper('commit-directory', { source: staged, destination: target, root: scope === 'system' ? systemRoot : null }, scope);
      owned[scope] ||= [];
      if (!owned[scope].some(item => normalizePathEntry(item) === normalizePathEntry(target))) owned[scope].push(target);
      await writeOwned(scope, ownedDirectoriesFile, systemOwnedDirectoriesFile, owned);
      return target;
    });
  }

  async function removeDirectory({ path: target, scope = 'user' }) {
    return serialized(async () => {
      assertScope(scope);
      const resolved = validateManagedDestination(target, scope, systemRoot);
      const owned = await readOwned(scope, ownedDirectoriesFile, systemOwnedDirectoriesFile, { user: [], system: [] });
      if (!(owned[scope] || []).some(item => normalizePathEntry(item) === normalizePathEntry(resolved))) {
        throw new Error('Only directories installed by this tool may be removed');
      }
      await invokeHelper('remove-directory', { target: resolved, root: scope === 'system' ? systemRoot : null }, scope);
      owned[scope] = owned[scope].filter(item => normalizePathEntry(item) !== normalizePathEntry(resolved));
      await writeOwned(scope, ownedDirectoriesFile, systemOwnedDirectoriesFile, owned);
    });
  }

  async function availableManagers() {
    const known = { scoop: new Set(), choco: new Set(), winget: new Set() };
    const [scoop, choco, winget] = await Promise.all([
      processRunner('scoop.cmd', ['list'], { timeout: 12000, allowFailure: true }).catch(() => null),
      processRunner('choco.exe', ['list', '--limit-output'], { timeout: 12000, allowFailure: true }).catch(() => null),
      processRunner('winget.exe', ['list', '--accept-source-agreements'], { timeout: 20000, allowFailure: true }).catch(() => null),
    ]);
    if (scoop?.code === 0) for (const line of scoop.stdout.split(/\r?\n/)) {
      const name = line.trim().split(/\s+/)[0]?.toLowerCase();
      if (name && /^[a-z][a-z0-9+.-]*$/.test(name)) known.scoop.add(name);
    }
    if (choco?.code === 0) for (const line of choco.stdout.split(/\r?\n/)) {
      const match = line.match(/^([a-z0-9+.-]+)\|/i);
      if (match) known.choco.add(match[1].toLowerCase());
    }
    if (winget?.code === 0) {
      const matches = winget.stdout.match(/(?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_.-]+/g) || [];
      for (const match of matches) known.winget.add(match);
    }
    return known;
  }

  async function listPackageVersions({ id, packageId } = {}) {
    if (!/^[A-Za-z0-9_.-]+$/.test(packageId || '') || WINGET_PACKAGES.get(id) !== packageId) {
      throw new Error('WinGet package does not match the supported catalog');
    }
    const result = await processRunner('winget.exe', ['show', '--id', packageId, '--exact', '--versions', '--accept-source-agreements'], {
      timeout: 20000, allowFailure: true,
    }).catch(() => null);
    if (!result || result.code !== 0) return [];
    const versions = [];
    for (const match of String(result.stdout || '').matchAll(/\bv?(\d+\.\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9.-]+)?)\b/g)) {
      if (!versions.includes(match[1])) versions.push(match[1]);
    }
    return versions.slice(0, 36);
  }

  async function scanRegistry() {
    const script = `
$items = @()
foreach ($hive in @('HKCU:', 'HKLM:')) {
  foreach ($node in @('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')) {
    Get-ItemProperty -Path ($hive + '\\' + $node) -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.DisplayName) { $items += [pscustomobject]@{ name=$_.DisplayName; version=$_.DisplayVersion; location=$_.InstallLocation; scope=$(if ($hive -eq 'HKCU:') {'user'} else {'system'}) } }
    }
  }
}
$items | ConvertTo-Json -Compress -Depth 3
`;
    const result = await processRunner('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], { timeout: 12000, allowFailure: true }).catch(() => null);
    if (!result || result.code !== 0 || !result.stdout.trim()) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch { return []; }
  }

  async function scanExternal(catalog = Object.keys(COMMANDS)) {
    const ids = new Set((Array.isArray(catalog) ? catalog : []).map(item => typeof item === 'string' ? item : item?.id));
    const expectedPackages = new Map((Array.isArray(catalog) ? catalog : [])
      .filter(item => item && typeof item === 'object' && item.packageId)
      .map(item => [item.id, item.packageId]));
    const [packages, registry] = await Promise.all([availableManagers(), scanRegistry()]);
    const found = [];
    for (const id of ids) {
      const commands = COMMANDS[id] || [];
      for (const command of commands) {
        const where = await processRunner('where.exe', [command.name], { timeout: 5000, allowFailure: true }).catch(() => null);
        if (!where || where.code !== 0) continue;
        for (const file of where.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, 8)) {
          if (!/^[a-zA-Z]:\\/.test(file) || /\\Microsoft\\WindowsApps\\/i.test(file)) continue;
          const versionResult = await processRunner(file, command.args, { timeout: 5000, allowFailure: true }).catch(() => null);
          const version = versionResult && parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
          if (!version) continue;
          found.push({ id, version, path: file, source: 'external', ...managerForPath(id, file, packages, expectedPackages.get(id)), scope: guessScope(file) });
        }
        if (found.some(item => item.id === id)) break;
      }
    }
    for (const item of registry) {
      if (!item.name || !item.version) continue;
      for (const id of ids) {
        if (!DISPLAY_NAMES[id]?.test(item.name)) continue;
        // Registry uninstall entries without an install directory cannot be activated or safely removed.
        if (!item.location || !/^[a-zA-Z]:\\/.test(item.location)) continue;
        const location = item.location;
        if (found.some(entry => entry.id === id && entry.version === item.version && (entry.path.toLowerCase().startsWith(location.toLowerCase()) || entry.path === location))) continue;
        found.push({ id, version: String(item.version), path: location, source: 'external', manager: 'unknown', scope: item.scope, updateable: false });
      }
    }
    const unique = new Map();
    for (const entry of found) unique.set(`${entry.id}\0${entry.version}\0${entry.path.toLowerCase()}`, entry);
    return [...unique.values()];
  }

  async function updateExternal({ id, manager, packageId, scope = 'user', signal, onLog } = {}) {
    assertScope(scope);
    const packages = await availableManagers();
    if (!['scoop', 'choco', 'winget'].includes(manager) || !packageId || !packages[manager].has(packageId.toLowerCase())) {
      throw new Error('Original package manager installation is not confirmed');
    }
    if (manager === 'scoop' && MANAGER_PACKAGES.scoop[id] !== packageId) throw new Error('Package does not match environment');
    if (manager === 'choco' && MANAGER_PACKAGES.choco[id] !== packageId) throw new Error('Package does not match environment');
    if (manager === 'winget' && !/^[A-Za-z0-9_.-]+$/.test(packageId)) throw new Error('Invalid WinGet package ID');
    const invocation = manager === 'scoop' ? ['scoop.cmd', ['update', packageId]]
      : manager === 'choco' ? ['choco.exe', ['upgrade', packageId, '--yes', '--no-progress']]
        : ['winget.exe', ['upgrade', '--id', packageId, '--exact', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']];
    if (scope === 'system') {
      return invokeHelper('manager-update', { manager, packageId }, scope, signal);
    }
    return processRunner(invocation[0], invocation[1], { signal, onLog, timeout: 30 * 60 * 1000 });
  }

  async function runInstaller({ file, args = [], scope = 'user', signal, onLog, env } = {}) {
    assertScope(scope);
    const executable = assertPathValue(file);
    if (!inside(path.win32.normalize(dataDir), executable) || !/\.(exe|msi|msix)$/i.test(executable)) {
      throw new Error('Installer must be a verified file in application data');
    }
    const real = await fsp.realpath(executable);
    if (!inside(path.win32.normalize(dataDir), real)) throw new Error('Installer resolves outside application data');
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid installer arguments');
    const extraEnv = {};
    if (env) {
      if (scope !== 'user' || !/rustup-init\.exe$/i.test(executable)) throw new Error('Custom installer environment is only supported for user-level rustup');
      for (const [name, value] of Object.entries(env)) {
        if (!['RUSTUP_HOME', 'CARGO_HOME'].includes(name)) throw new Error(`Installer environment variable is not allowed: ${name}`);
        extraEnv[name] = assertPathValue(value);
      }
    }
    if (scope === 'system') return invokeHelper('run-installer', { file: executable, args }, scope, signal);
    if (/\.msi$/i.test(executable)) return processRunner('msiexec.exe', ['/i', executable, ...args], { signal, onLog, timeout: 45 * 60 * 1000 });
    return processRunner(executable, args, { signal, onLog, env: { ...process.env, ...extraEnv }, timeout: 45 * 60 * 1000 });
  }

  async function installPackage({ manager, packageId, id, version = 'latest', scope = 'user', signal, onLog, msysRoot } = {}) {
    assertScope(scope);
    if (manager === 'winget') {
      if (!/^[A-Za-z0-9_.-]+$/.test(packageId || '') || WINGET_PACKAGES.get(id) !== packageId) {
        throw new Error('WinGet package does not match the supported catalog');
      }
      const args = ['install', '--id', packageId, '--exact', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
      if (version && version !== 'latest') args.push('--version', version);
      if (scope === 'system') return invokeHelper('manager-install', { manager, packageId }, scope, signal);
      return processRunner('winget.exe', args, { signal, onLog, timeout: 45 * 60 * 1000 });
    }
    if (manager === 'msys2') {
      if (!['mingw-w64-x86_64-gcc', 'lua'].includes(packageId)) throw new Error('MSYS2 package is not supported');
      if (scope !== 'user') throw new Error('MSYS2 system installation is not supported');
      const root = validateManagedDestination(msysRoot, 'user', systemRoot);
      const owned = await readOwned(scope, ownedDirectoriesFile, systemOwnedDirectoriesFile, { user: [] });
      if (!(owned.user || []).some(item => normalizePathEntry(item) === normalizePathEntry(root))) {
        throw new Error('MSYS2 root was not installed by this tool');
      }
      const executable = path.win32.join(root, 'usr', 'bin', 'pacman.exe');
      if (!fs.existsSync(executable)) throw new Error('MSYS2 pacman is not installed');
      return processRunner(executable, ['-S', '--noconfirm', '--needed', packageId], { signal, onLog, timeout: 45 * 60 * 1000 });
    }
    throw new Error('Unsupported package manager');
  }

  async function uninstallPackage({ manager, packageId, id, scope = 'user', signal, onLog } = {}) {
    assertScope(scope);
    if (manager !== 'winget' || !/^[A-Za-z0-9_.-]+$/.test(packageId || '') || WINGET_PACKAGES.get(id) !== packageId) {
      throw new Error('Only tracked WinGet packages can be uninstalled');
    }
    if (scope === 'system') return invokeHelper('manager-uninstall', { manager, packageId }, scope, signal);
    return processRunner('winget.exe', ['uninstall', '--id', packageId, '--exact', '--disable-interactivity'],
      { signal, onLog, timeout: 45 * 60 * 1000 });
  }

  async function verify({ command, args = ['--version'], expectedVersion, env, signal } = {}) {
    const executable = assertPathValue(command);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Invalid verification arguments');
    let file = executable;
    let argv = args;
    if (/\.(bat|cmd)$/i.test(executable)) {
      if (/[%!^&|<>]/.test(executable) || args.some(arg => !/^[A-Za-z0-9._=+/-]+$/.test(arg))) {
        throw new Error('Unsafe batch verification command');
      }
      file = 'cmd.exe';
      argv = ['/d', '/s', '/c', `"${executable}" ${args.join(' ')}`];
    }
    const result = await processRunner(file, argv, { env, signal, timeout: 12000 });
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (!version) throw new Error('Installed command did not report a version');
    if (expectedVersion && version !== expectedVersion && !version.startsWith(`${expectedVersion}.`) && !expectedVersion.startsWith(`${version}.`)) {
      throw new Error(`Installed command reports ${version}; expected ${expectedVersion}`);
    }
    return { version, path: executable };
  }

  return {
    chooseRoot, scanExternal, availableManagers, listPackageVersions, previewPathChange, applyPath,
    activatePaths, removePaths, applyEnvironment, commitDirectory,
    removeDirectory, updateExternal, runInstaller, installPackage, uninstallPackage, verify,
    applyRegistryMirrors,
  };

  async function applyRegistryMirrors(options = {}) {
    return serialized(async () => {
      const mirrorChoices = options.mirrors || options;
      const keys = ['pip', 'npm', 'maven', 'cargo', 'go'];
      if (!mirrorChoices || typeof mirrorChoices !== 'object' ||
          Object.keys(mirrorChoices).some(key => !keys.includes(key) || typeof mirrorChoices[key] !== 'boolean')) {
        throw new Error('Invalid registry mirror settings');
      }
      const mapping = {
        pip: { name: 'PIP_INDEX_URL', value: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
        npm: { name: 'NPM_CONFIG_REGISTRY', value: 'https://registry.npmmirror.com' },
        cargo: { name: 'CARGO_REGISTRIES_CRATES_IO_INDEX', value: 'sparse+https://rsproxy.cn/index/' },
        go: { name: 'GOPROXY', value: 'https://goproxy.cn,direct' },
      };
      const initial = await readJson(mirrorStateFile, {});
      const state = { ...initial };
      const applied = [];
      try {
        for (const key of keys) {
          if (!Object.hasOwn(mirrorChoices, key) || Boolean(state[key]) === mirrorChoices[key]) continue;
          let setting = mapping[key];
          if (key === 'maven') {
            const target = path.join(dataDir, 'registry-mirrors', 'maven-settings.xml');
            const previous = await invokeHelper('read-env', { scope: 'user', name: 'MAVEN_ARGS' });
            if (mirrorChoices[key]) {
              if (/--(?:settings|global-settings)\b|-s\s/i.test(previous.value || '')) {
                throw new Error('Maven already uses custom settings; automatic mirror configuration would override them');
              }
              await invokeHelper('maven-settings', { source: path.join(os.homedir(), '.m2', 'settings.xml'), target });
              setting = { name: 'MAVEN_ARGS', value: `--settings "${target}"${previous.value ? ` ${previous.value}` : ''}` };
            } else {
              setting = { name: 'MAVEN_ARGS', value: state.maven.value };
            }
          }
          if (mirrorChoices[key]) {
            const change = await invokeHelper('env-change', {
              scope: 'user', name: setting.name, value: setting.value,
              backupDir: path.join(dataDir, 'backups'),
            });
            state[key] = { name: setting.name, value: setting.value, backupFile: change.backupFile };
            applied.push({ key, enabled: true, state: state[key] });
          } else {
            const current = await invokeHelper('read-env', { scope: 'user', name: state[key].name });
            if (current.value !== state[key].value) {
              throw new Error(`${key} registry was changed outside this tool; restore it manually`);
            }
            await invokeHelper('restore-env', {
              scope: 'user', name: state[key].name, backupFile: state[key].backupFile,
            });
            applied.push({ key, enabled: false, state: state[key] });
            delete state[key];
          }
        }
        await atomicJson(mirrorStateFile, state);
      } catch (error) {
        for (const action of applied.reverse()) {
          if (action.enabled) {
            await invokeHelper('restore-env', {
              scope: 'user', name: action.state.name, backupFile: action.state.backupFile,
            }).catch(() => {});
          } else {
            await invokeHelper('env-change', {
              scope: 'user', name: action.state.name, value: action.state.value,
              backupDir: path.join(dataDir, 'backups'),
            }).catch(() => {});
          }
        }
        throw error;
      }
      if (!state.maven && initial.maven) {
        await fsp.rm(path.join(dataDir, 'registry-mirrors', 'maven-settings.xml'), { force: true }).catch(() => {});
      }
      emit('platform:registries-changed', keys.filter(key => Boolean(state[key])));
      return Object.fromEntries(keys.map(key => [key, Boolean(state[key])]));
    });
  }
}

module.exports = {
  createWindowsPlatform, normalizePathEntry, splitPath, previewPathValue,
  validateManagedDestination, parseVersion, managerForPath,
};
