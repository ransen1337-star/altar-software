const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createInstallerService } = require('../../electron/installer/index.cjs');
const { createProviders } = require('../../electron/installer/providers.cjs');
const { downloadFile, IntegrityError } = require('../../electron/installer/downloader.cjs');
const { publicCatalog } = require('../../electron/installer/catalog.cjs');

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

test('catalog exposes all supported Windows environments and capability flags', async () => {
  const ids = publicCatalog.map(item => item.id);
  assert.deepEqual(ids, ['python', 'node', 'jdk', 'go', 'rust', 'dotnet', 'cpp', 'php', 'ruby', 'dart', 'r', 'julia', 'perl', 'lua', 'kotlin', 'scala']);
  for (const item of publicCatalog) {
    assert.equal(typeof item.supportsCustomPath, 'boolean');
    assert.equal(typeof item.supportsSystemScope, 'boolean');
    assert.equal(typeof item.supportsPath, 'boolean');
  }
});

test('package-managed environments expose real versions instead of repeating latest', async () => {
  const providers = createProviders({ packageVersionsImpl: async ({ id }) => id === 'python' ? ['3.13.7', '3.12.10'] : [] });
  assert.deepEqual(await providers.versions('python'), ['3.13.7', '3.12.10']);
  assert.deepEqual(await providers.versions('php'), ['latest']);
});

test('download region changes the preferred source order', async () => {
  const hash = 'a'.repeat(64);
  const fetchImpl = async url => {
    if (url.endsWith('/index.json')) return new Response(JSON.stringify([{ version: 'v22.1.0', files: ['win-x64-zip'] }]));
    if (url.endsWith('/SHASUMS256.txt')) return new Response(`${hash}  node-v22.1.0-win-x64.zip\n`);
    throw new Error(`Unexpected metadata URL: ${url}`);
  };
  const providers = createProviders({ fetchImpl });
  const auto = await providers.resolve('node', '22.1.0', 'auto');
  const china = await providers.resolve('node', '22.1.0', 'china');
  const international = await providers.resolve('node', '22.1.0', 'international');
  assert.equal(auto.urls[0], 'https://nodejs.org/dist/v22.1.0/node-v22.1.0-win-x64.zip');
  assert.equal(china.urls[0], 'https://cdn.npmmirror.com/binaries/node/v22.1.0/node-v22.1.0-win-x64.zip');
  assert.deepEqual(international.urls, ['https://nodejs.org/dist/v22.1.0/node-v22.1.0-win-x64.zip']);
});

test('configured GitHub mirror supplies versions and takes priority', async () => {
  const hash = 'b'.repeat(64);
  const fetchImpl = async url => {
    assert.equal(url, 'https://raw.example.test/dev/mirror/manifest.json');
    return new Response(JSON.stringify({ artifacts: [{
      id: 'node', version: '22.1.0', filename: 'node-v22.1.0-win-x64.zip',
      hash, algorithm: 'sha256', archive: 'zip',
      urls: ['https://nodejs.org/dist/v22.1.0/node-v22.1.0-win-x64.zip'],
    }] }), { status: 200 });
  };
  const providers = createProviders({ mirrorBaseUrl: 'https://raw.example.test/dev/mirror', fetchImpl });
  assert.deepEqual(await providers.versions('node'), ['22.1.0']);
  const release = await providers.resolve('node', '22.1.0');
  assert.equal(release.urls[0], 'https://raw.example.test/dev/mirror/node/22.1.0/node-v22.1.0-win-x64.zip');
  assert.equal(release.hash, hash);
});

test('segmented downloader uses at most four ranges and verifies the assembled artifact', async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 37);
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push(init);
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } });
    const range = init.headers?.Range || init.headers?.range;
    if (!range) return new Response(bytes);
    const [start, end] = range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    const body = bytes.subarray(start, end + 1);
    return new Response(body, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-downloader-'));
  const destination = path.join(dir, 'artifact.zip');
  await downloadFile({ urls: ['https://example.test/artifact.zip'], destination, hash: sha256(bytes), fetchImpl, maxConnections: 4 });
  assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal(requests.filter(item => item.headers?.Range).length, 4);
});

test('downloader uses uncompressed artifact size when HEAD advertises a compressed response', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 9, 41);
  const fetchImpl = async (_url, init = {}) => {
    assert.equal(init.headers['Accept-Encoding'], 'identity');
    if (init.method === 'HEAD') return new Response(null, {
      headers: { 'content-length': String(bytes.length - 100), 'content-encoding': 'gzip', 'accept-ranges': 'bytes' },
    });
    const range = init.headers.Range;
    const [start, end] = range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return new Response(bytes.subarray(start, end + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-encoded-head-'));
  const destination = path.join(dir, 'artifact.zip');
  await downloadFile({ urls: ['https://example.test/artifact.zip'], destination, hash: sha256(bytes), fetchImpl });
  assert.deepEqual(await fs.readFile(destination), bytes);
});

test('downloader discards parts from a different artifact before resuming', async () => {
  const bytes = Buffer.from('current verified artifact');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-stale-parts-'));
  const destination = path.join(dir, 'artifact.zip');
  await fs.writeFile(`${destination}.part-0`, Buffer.from('stale bytes'));
  await fs.writeFile(`${destination}.parts.json`, JSON.stringify({ url: 'https://old.test/artifact.zip' }));
  const fetchImpl = async (_url, init = {}) => init.method === 'HEAD'
    ? new Response(null, { headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } })
    : new Response(bytes);
  await downloadFile({ urls: ['https://example.test/artifact.zip'], destination, hash: sha256(bytes), fetchImpl });
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(fs.access(`${destination}.parts.json`));
});

test('downloader rejects a range response with a different total size', async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 13);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-range-size-'));
  const fetchImpl = async (_url, init = {}) => {
    if (init.method === 'HEAD') return new Response(null, {
      headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' },
    });
    const [start, end] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).slice(1).map(Number);
    return new Response(bytes.subarray(start, end + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length + 1}` },
    });
  };
  await assert.rejects(downloadFile({
    urls: ['https://example.test/artifact.zip'], destination: path.join(dir, 'artifact.zip'),
    hash: sha256(bytes), fetchImpl,
  }), /unexpected byte range/);
});

test('downloader rejects a checksum mismatch and leaves no completed artifact', async () => {
  const bytes = Buffer.from('not-the-expected-content');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-integrity-'));
  const destination = path.join(dir, 'artifact.zip');
  const fetchImpl = async (_url, init = {}) => init.method === 'HEAD'
    ? new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } })
    : new Response(bytes);
  await assert.rejects(
    downloadFile({ urls: ['https://example.test/artifact.zip'], destination, hash: '0'.repeat(64), fetchImpl }),
    error => error instanceof IntegrityError,
  );
  await assert.rejects(fs.access(destination));
});

test('downloader automatically changes to a verified fallback source', async () => {
  const bytes = Buffer.from('verified artifact');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('primary')) throw new Error('primary unavailable');
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(bytes.length) } });
    return new Response(bytes);
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-source-confirm-'));
  const destination = path.join(root, 'artifact.zip');
  let fallbackLogged = false;
  await downloadFile({
    urls: ['https://primary.test/artifact.zip', 'https://backup.test/artifact.zip'],
    destination, hash: sha256(bytes), fetchImpl,
    onSourceFallback: async ({ nextUrl }) => { fallbackLogged = nextUrl.includes('backup.test'); },
  });
  assert.equal(fallbackLogged, true);
  assert.equal(calls.some(url => url.includes('backup.test')), true);
});

test('installer queue drains concurrent jobs while serializing package operations and accepts mirror settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devenv-service-'));
  const installed = new Set();
  let active = 0;
  let peak = 0;
  const platform = {
    async scanExternal() {
      return [...installed].map((id, index) => ({ id, version: '3.13.0', path: `C:\\External\\${id}-${index}`, source: 'external', manager: 'winget', packageId: id === 'python' ? 'Python.Python.3.13' : undefined, scope: 'user', updateable: true }));
    },
    async installPackage({ id }) {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 25));
      installed.add(id);
      active -= 1;
    },
    async applyRegistryMirrors() {},
  };
  const service = createInstallerService({ dataDir: root, platform });
  const jobs = await Promise.all(Array.from({ length: 4 }, () => service.install({ id: 'python', version: 'latest', scope: 'user', addToPath: false })));
  assert.equal(jobs.length, 4);
  await new Promise(async (resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = async () => {
      const current = await service.jobs();
      if (current.every(job => ['completed', 'failed', 'cancelled'].includes(job.status))) return resolve();
      if (Date.now() > deadline) return reject(new Error('queue did not drain'));
      setTimeout(poll, 20);
    };
    poll();
  });
  assert.equal(peak, 1);
  const settings = await service.setSettings({ sourceRegion: 'china', registryMirrors: { pip: true, npm: false, maven: true, cargo: false, go: true } });
  assert.equal(settings.sourceRegion, 'china');
  assert.equal(settings.registryMirrors.npm, false);
});
