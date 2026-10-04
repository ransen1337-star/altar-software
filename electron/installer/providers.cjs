const dns = require('node:dns');
const { catalog } = require('./catalog.cjs');

dns.setDefaultResultOrder?.('ipv4first');

const RELEASE_CACHE_MS = 15 * 60 * 1000;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,80}$/;

function createProviders({ fetchImpl = fetch, packageVersionsImpl, mirrorBaseUrl } = {}) {
  const cache = new Map();

  function configuredMirrorBase() {
    const value = typeof mirrorBaseUrl === 'function' ? mirrorBaseUrl() : mirrorBaseUrl;
    if (!value) return '';
    const base = String(value).trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) throw new Error('Mirror repository URL requires HTTPS');
    return base;
  }

  async function fetchText(url) {
    if (!url.startsWith('https://')) throw new Error('Release metadata requires HTTPS');
    const cached = cache.get(url);
    if (cached && Date.now() - cached.time < RELEASE_CACHE_MS) return cached.value;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': 'Altar/1.0', Accept: 'application/json, text/plain, */*' },
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error(`Release feed HTTP ${response.status}`);
        const value = await response.text();
        cache.set(url, { time: Date.now(), value });
        return value;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw new Error(`无法访问版本源 ${url}：${lastError?.message || '网络请求失败'}`);
  }

  async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

  async function mirrorManifest() {
    const base = configuredMirrorBase();
    if (!base) return null;
    try { return await fetchJson(`${base}/manifest.json`); } catch { return null; }
  }

  async function mirrorArtifact(id, version) {
    const manifest = await mirrorManifest();
    const item = manifest?.artifacts?.find(entry => entry.id === id && entry.version === version && entry.hash && entry.filename);
    if (!item) return null;
    const mirrorUrl = `${configuredMirrorBase()}/${id}/${version}/${item.filename}`;
    const fallback = Array.isArray(item.urls) ? item.urls : [];
    return {
      id, version, actualVersion: item.actualVersion || version, filename: item.filename,
      urls: [...new Set([mirrorUrl, ...fallback.filter(url => url !== mirrorUrl)])],
      hash: item.hash.toLowerCase(), algorithm: item.algorithm || (item.hash.length === 128 ? 'sha512' : 'sha256'),
      archive: item.archive || (item.filename.endsWith('.tar.xz') ? 'tar.xz' : item.filename.endsWith('.tar.gz') ? 'tar.gz' : 'zip'),
    };
  }

  function checksum(text) {
    const match = text.match(/\b([a-f0-9]{128}|[a-f0-9]{64})\b/i);
    if (!match) throw new Error('Official release checksum is missing');
    return match[1].toLowerCase();
  }

  async function nodeReleases(region = 'auto') {
    const url = region === 'china' ? 'https://npmmirror.com/mirrors/node/index.json' : 'https://nodejs.org/dist/index.json';
    return (await fetchJson(url))
      .filter(item => item.files?.includes('win-x64-zip')).slice(0, 36);
  }

  async function goReleases(region = 'auto') {
    const url = region === 'china' ? 'https://golang.google.cn/dl/?mode=json' : 'https://go.dev/dl/?mode=json';
    return (await fetchJson(url))
      .filter(item => item.stable && item.files?.some(file => file.filename.endsWith('.windows-amd64.zip')));
  }

  async function dotnetIndex() {
    return (await fetchJson('https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json'))
      ['releases-index'].filter(item => item['support-phase'] === 'active' && !item['latest-sdk'].includes('-'));
  }

  async function latestGithub(repo) {
    return fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  }

  async function versions(id, region = 'auto') {
    const item = catalog.find(entry => entry.id === id);
    if (!item) throw new Error(`Unknown environment: ${id}`);
    const mirrored = await mirrorManifest();
    const mirroredVersions = mirrored?.artifacts?.filter(entry => entry.id === id && entry.hash).map(entry => entry.version);
    if (mirroredVersions?.length) return [...new Set(mirroredVersions)];
    if (item.installMethod === 'winget') {
      const discovered = await packageVersionsImpl?.({ id, packageId: item.packageId });
      return Array.isArray(discovered) && discovered.length ? discovered : ['latest'];
    }
    switch (id) {
      case 'node': return (await nodeReleases(region)).map(entry => entry.version.replace(/^v/, ''));
      case 'go': return (await goReleases(region)).map(entry => entry.version.replace(/^go/, ''));
      case 'jdk': {
        const info = await fetchJson('https://api.adoptium.net/v3/info/available_releases');
        return [...info.available_lts_releases].reverse().map(String);
      }
      case 'dotnet': return (await dotnetIndex()).map(entry => entry['latest-sdk']);
      case 'dart': return [(await fetchJson('https://storage.googleapis.com/dart-archive/channels/stable/release/latest/VERSION')).version];
      case 'kotlin': return [(await latestGithub('JetBrains/kotlin')).tag_name.replace(/^v/, '')];
      case 'scala': return [(await latestGithub('scala/scala3')).tag_name.replace(/^v/, '')];
      case 'cpp':
      case 'lua': {
        const releases = await fetchJson('https://api.github.com/repos/msys2/msys2-installer/releases?per_page=5');
        return releases.filter(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry.tag_name)).map(entry => entry.tag_name);
      }
      default: throw new Error(`No release feed for ${id}`);
    }
  }

  async function resolve(id, version, region = 'auto') {
    if (!VERSION_PATTERN.test(version)) throw new Error('Invalid version');
    if (!['auto', 'china', 'international'].includes(region)) throw new Error('Invalid source region');
    const mirrored = await mirrorArtifact(id, version);
    if (mirrored) return mirrored;
    let filename, hash, url, mirrors = [], actualVersion = version;
    switch (id) {
      case 'node': {
        const release = (await nodeReleases(region)).find(item => item.version === `v${version}`);
        if (!release) throw new Error('Node.js version is not in the official release feed');
        filename = `node-v${version}-win-x64.zip`;
        hash = checksum((await fetchText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`))
          .split('\n').find(line => line.trim().split(/\s+/).at(-1) === filename) || '');
        url = `https://nodejs.org/dist/v${version}/${filename}`;
        // Use the CDN directly. The npmmirror front door redirects large files,
        // and redirecting range requests is unreliable on some Windows networks.
        mirrors = [`https://cdn.npmmirror.com/binaries/node/v${version}/${filename}`];
        break;
      }
      case 'go': {
        const release = (await goReleases(region)).find(item => item.version === `go${version}`);
        const file = release?.files?.find(entry => entry.filename === `go${version}.windows-amd64.zip`);
        if (!file) throw new Error('Go version is not in the official release feed');
        filename = file.filename; hash = file.sha256;
        url = `https://dl.google.com/go/${filename}`;
        mirrors = [`https://mirrors.ustc.edu.cn/golang/${filename}`];
        break;
      }
      case 'jdk': {
        const releases = await fetchJson(`https://api.adoptium.net/v3/assets/latest/${version}/hotspot?architecture=x64&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse`);
        const release = releases[0];
        if (!release?.binary?.package?.checksum) throw new Error('Temurin release has no verified Windows package');
        filename = release.binary.package.name;
        hash = release.binary.package.checksum;
        url = release.binary.package.link;
        actualVersion = release.version.openjdk_version;
        break;
      }
      case 'dotnet': {
        const channel = (await dotnetIndex()).find(entry => entry['latest-sdk'] === version);
        if (!channel) throw new Error('.NET SDK version is not in the active release index');
        const releases = await fetchJson(channel['releases.json']);
        const sdk = releases.releases.flatMap(release => [release.sdk, ...(release.sdks || [])])
          .find(entry => entry?.version === version);
        const file = sdk?.files?.find(entry => entry.rid === 'win-x64' && entry.name.endsWith('.zip'));
        if (!file?.hash) throw new Error('.NET SDK Windows ZIP checksum is missing');
        filename = `dotnet-sdk-${version}-win-x64.zip`; hash = file.hash; url = file.url;
        break;
      }
      case 'dart': {
        if (!(await versions('dart')).includes(version)) throw new Error('Only the latest Dart SDK is available');
        filename = 'dartsdk-windows-x64-release.zip';
        const base = `https://storage.googleapis.com/dart-archive/channels/stable/release/${version}/sdk/${filename}`;
        hash = checksum(await fetchText(`${base}.sha256sum`)); url = base;
        break;
      }
      case 'kotlin':
      case 'scala': {
        const release = await latestGithub(id === 'kotlin' ? 'JetBrains/kotlin' : 'scala/scala3');
        if (release.tag_name.replace(/^v/, '') !== version) throw new Error('Only the latest compiler release is available');
        filename = id === 'kotlin' ? `kotlin-compiler-${version}.zip` : `scala3-${version}-x86_64-pc-win32.zip`;
        const asset = release.assets.find(entry => entry.name === filename);
        const digest = release.assets.find(entry => entry.name === `${filename}.sha256`);
        if (!asset || !digest) throw new Error('Compiler archive or official checksum is missing');
        hash = checksum(await fetchText(digest.browser_download_url));
        url = asset.browser_download_url;
        break;
      }
      case 'cpp':
      case 'lua': {
        const release = await fetchJson(`https://api.github.com/repos/msys2/msys2-installer/releases/tags/${version}`);
        if (release.tag_name !== version) throw new Error('MSYS2 release was not found');
        filename = `msys2-base-x86_64-${version.replace(/-/g, '')}.tar.xz`;
        const asset = release.assets.find(entry => entry.name === filename);
        if (!asset?.digest?.startsWith('sha256:')) throw new Error('MSYS2 base archive has no official digest');
        hash = asset.digest.slice('sha256:'.length);
        url = asset.browser_download_url;
        break;
      }
      default: throw new Error(`${id} uses a managed installer, not an archive`);
    }
    if (!/^https:\/\//.test(url)) throw new Error('Release artifact requires HTTPS');
    if (!/^[A-Za-z0-9._+-]+$/.test(filename)) throw new Error('Release artifact has an unsafe filename');
    if (!/^[a-f0-9]{64}$|^[a-f0-9]{128}$/i.test(hash)) throw new Error('Invalid official checksum');
    // Automatic mode favors the canonical source; China mode explicitly favors a verified mirror.
    const repository = configuredMirrorBase();
    const repositoryUrl = repository ? `${repository}/${id}/${version}/${filename}` : null;
    const urls = region === 'international'
      ? [url]
      : region === 'china'
        ? [...mirrors, url]
        : [url, ...mirrors];
    if (repositoryUrl) urls.unshift(repositoryUrl);
    const archive = filename.endsWith('.tar.xz') ? 'tar.xz' : filename.endsWith('.tar.gz') ? 'tar.gz' : 'zip';
    return { id, version, actualVersion, filename, urls: [...new Set(urls)], hash: hash.toLowerCase(), algorithm: hash.length === 128 ? 'sha512' : 'sha256', archive };
  }

  return { versions, resolve };
}

module.exports = { createProviders };
