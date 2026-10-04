'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createWindowsPlatform, normalizePathEntry, previewPathValue,
  validateManagedDestination, managerForPath,
} = require('../../electron/platform/windows.cjs');

async function fixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dev-env-platform-'));
  const values = new Map(Object.entries(options.values || {}));
  const backups = new Map();
  const state = new Map();
  const calls = [];
  const helperInvoker = async (action, payload, scope) => {
    calls.push({ action, payload, scope });
    const key = `${payload.scope || scope}:${payload.name || 'Path'}`;
    if (action === 'read-state') return state.get(payload.file) || null;
    if (action === 'write-state') { state.set(payload.file, payload.value); return { written: true }; }
    if (action === 'read-env') return { value: values.get(key) || '' };
    if (action === 'path-change') {
      const previous = values.get(`${scope}:Path`) || '';
      const next = previewPathValue(previous, payload.add, payload.remove);
      values.set(`${scope}:Path`, next);
      const backupFile = `backup-${backups.size}`;
      backups.set(backupFile, { key: `${scope}:Path`, value: previous });
      return { previous, next, backupFile };
    }
    if (action === 'env-change') {
      const previous = values.get(key);
      const backupFile = `backup-${backups.size}`;
      backups.set(backupFile, { key, value: previous });
      if (payload.value === null) values.delete(key);
      else values.set(key, payload.value);
      return { previous, next: payload.value, backupFile };
    }
    if (action === 'restore-env') {
      const backup = backups.get(payload.backupFile);
      assert.ok(backup);
      if (backup.value === undefined) values.delete(backup.key);
      else values.set(backup.key, backup.value);
      return { restored: true };
    }
    if (action === 'maven-settings') return { target: payload.target };
    return {};
  };
  const platform = createWindowsPlatform({ dataDir, helperInvoker, processRunner: options.processRunner });
  return { platform, values, calls, dataDir, cleanup: () => fs.rm(dataDir, { recursive: true, force: true }) };
}

test('PATH comparison is case insensitive and preserves first spelling', () => {
  assert.equal(normalizePathEntry(' C:/Tools/Node/ '), 'c:\\tools\\node');
  assert.equal(previewPathValue('C:\\Tools\\Node;C:\\Windows', ['c:\\tools\\node\\', 'D:\\Go'], ['C:\\WINDOWS']),
    'C:\\Tools\\Node;D:\\Go');
});

test('adding PATH is idempotent and removal is limited to paths the tool owns', async () => {
  const f = await fixture({ values: { 'user:Path': 'C:\\Shared' } });
  try {
    await f.platform.activatePaths({ scope: 'user', paths: ['D:\\Managed\\bin'] });
    await f.platform.activatePaths({ scope: 'user', paths: ['d:\\managed\\bin\\'] });
    assert.equal(f.values.get('user:Path'), 'C:\\Shared;D:\\Managed\\bin');
    await f.platform.removePaths({ scope: 'user', paths: ['C:\\Shared', 'D:\\Managed\\bin'] });
    assert.equal(f.values.get('user:Path'), 'C:\\Shared');
  } finally { await f.cleanup(); }
});

test('an existing PATH entry is never claimed as owned', async () => {
  const f = await fixture({ values: { 'user:Path': 'D:\\Existing\\bin' } });
  try {
    await f.platform.activatePaths({ scope: 'user', paths: ['d:\\existing\\bin'] });
    const preview = await f.platform.previewPathChange({ scope: 'user', remove: ['D:\\Existing\\bin'] });
    assert.equal(preview.next, 'D:\\Existing\\bin');
    await f.platform.removePaths({ scope: 'user', paths: ['D:\\Existing\\bin'] });
    assert.equal(f.values.get('user:Path'), 'D:\\Existing\\bin');
  } finally { await f.cleanup(); }
});

test('system paths and directories must remain under ProgramData managed root', async () => {
  const f = await fixture();
  try {
    const root = f.platform.chooseRoot('system', 'node');
    assert.match(root, /DevEnvManager\\environments\\node$/);
    await assert.rejects(f.platform.activatePaths({ scope: 'system', paths: ['C:\\Windows\\System32'] }), /managed installation/);
    assert.throws(() => validateManagedDestination('C:\\ProgramData\\DevEnvManager\\environments\\..\\..\\Windows', 'system', 'C:\\ProgramData\\DevEnvManager\\environments'), /managed ProgramData/);
    assert.throws(() => validateManagedDestination('C:\\Windows\\Temp\\DevEnv', 'user', 'C:\\ProgramData\\DevEnvManager\\environments'), /protected parent/);
    assert.throws(() => validateManagedDestination('C:\\Program Files\\DevEnv', 'user', 'C:\\ProgramData\\DevEnvManager\\environments'), /protected parent/);
  } finally { await f.cleanup(); }
});

test('system ownership state is separated from user data and accepts only managed paths', async () => {
  const f = await fixture({ values: { 'system:Path': 'C:\\Windows\\System32' } });
  try {
    const managedBin = `${f.platform.chooseRoot('system', 'node')}\\bin`;
    await f.platform.activatePaths({ scope: 'system', paths: [managedBin] });
    assert.equal(f.values.get('system:Path'), `C:\\Windows\\System32;${managedBin}`);
    assert.equal(f.calls.some(call => call.action === 'write-state' && call.scope === 'system'), true);
    await f.platform.removePaths({ scope: 'system', paths: [managedBin] });
    assert.equal(f.values.get('system:Path'), 'C:\\Windows\\System32');
  } finally { await f.cleanup(); }
});

test('registry mirrors require opt-in and restore previous user values', async () => {
  const f = await fixture({ values: { 'user:GOPROXY': 'https://private.example,off' } });
  try {
    await f.platform.applyRegistryMirrors({ go: true, npm: true });
    assert.equal(f.values.get('user:GOPROXY'), 'https://goproxy.cn,direct');
    assert.equal(f.values.get('user:NPM_CONFIG_REGISTRY'), 'https://registry.npmmirror.com');
    await f.platform.applyRegistryMirrors({ go: false, npm: false });
    assert.equal(f.values.get('user:GOPROXY'), 'https://private.example,off');
    assert.equal(f.values.has('user:NPM_CONFIG_REGISTRY'), false);
  } finally { await f.cleanup(); }
});

test('mirror disable refuses to overwrite a later external change', async () => {
  const f = await fixture();
  try {
    await f.platform.applyRegistryMirrors({ pip: true });
    f.values.set('user:PIP_INDEX_URL', 'https://company.example/simple');
    await assert.rejects(f.platform.applyRegistryMirrors({ pip: false }), /changed outside this tool/);
    assert.equal(f.values.get('user:PIP_INDEX_URL'), 'https://company.example/simple');
  } finally { await f.cleanup(); }
});

test('external package manager attribution requires package listing and matching path', () => {
  const packages = { scoop: new Set(['python']), choco: new Set(), winget: new Set(['Python.Python.3.13']) };
  assert.deepEqual(managerForPath('python', 'C:\\Users\\Me\\scoop\\shims\\python.exe', packages),
    { manager: 'scoop', packageId: 'python', updateable: true });
  assert.deepEqual(managerForPath('python', 'C:\\Other\\python.exe', packages, 'Python.Python.3.13'),
    { manager: 'unknown', updateable: false });
  assert.deepEqual(managerForPath('python', 'C:\\Users\\Me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Python.Python.3.13_x64\\python.exe', packages, 'Python.Python.3.13'),
    { manager: 'winget', packageId: 'Python.Python.3.13', updateable: true });
});

test('external update rejects package without confirmed manager installation', async () => {
  const runner = async () => ({ code: 1, stdout: '', stderr: '' });
  const f = await fixture({ processRunner: runner });
  try {
    await assert.rejects(f.platform.updateExternal({ id: 'python', manager: 'winget', packageId: 'Python.Python.3.13' }), /not confirmed/);
  } finally { await f.cleanup(); }
});
