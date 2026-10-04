const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

class IntegrityError extends Error {
  constructor(message) { super(message); this.name = 'IntegrityError'; }
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

async function clearParts(destination) {
  const directory = path.dirname(destination);
  const prefix = `${path.basename(destination)}.part-`;
  for (const entry of await fsp.readdir(directory).catch(() => [])) {
    if (entry.startsWith(prefix)) await fsp.rm(path.join(directory, entry), { force: true });
  }
  await fsp.rm(`${destination}.parts.json`, { force: true });
}

async function probe(url, signal, fetchImpl) {
  let response;
  const headers = { 'User-Agent': 'Altar/1.0', 'Accept-Encoding': 'identity' };
  try {
    response = await fetchImpl(url, { method: 'HEAD', signal, headers });
  } catch (error) {
    if (signal?.aborted) throw error;
    response = await fetchImpl(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
  }
  if (!response.ok && response.status !== 405) throw new Error(`Download source returned HTTP ${response.status}`);
  if (response.status === 405 || (response.headers.get('content-encoding') && !response.headers.get('content-range'))) {
    if (response.body) await response.body.cancel();
    response = await fetchImpl(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal });
    if (!response.ok) throw new Error(`Download source returned HTTP ${response.status}`);
  }
  const contentRange = response.headers.get('content-range') || '';
  const totalFromRange = contentRange.match(/\/([0-9]+)$/)?.[1];
  const encoded = response.headers.get('content-encoding');
  const size = Number(totalFromRange || (encoded ? null : response.headers.get('content-length')));
  if (response.body) await response.body.cancel();
  return {
    size: Number.isSafeInteger(size) && size > 0 ? size : 0,
    ranges: !!totalFromRange || (size > 0 && /\bbytes\b/i.test(response.headers.get('accept-ranges') || '')),
    validator: response.headers.get('etag') || response.headers.get('last-modified') || '',
  };
}

async function appendResponse(url, file, start, end, size, signal, fetchImpl, onBytes, rangeRequired) {
  const headers = { 'User-Agent': 'Altar/1.0', 'Accept-Encoding': 'identity' };
  if (rangeRequired) headers.Range = `bytes=${start}-${end}`;
  const response = await fetchImpl(url, { headers, signal });
  if (rangeRequired && response.status !== 206) throw new Error('Source did not honor byte ranges');
  if (!rangeRequired && !response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  if (response.headers.get('content-encoding')) throw new Error('Source returned encoded download bytes');
  if (rangeRequired) {
    const range = response.headers.get('content-range') || '';
    if (range !== `bytes ${start}-${end}/${size}`) throw new Error('Source returned an unexpected byte range');
  }
  if (!response.body) throw new Error('Download returned an empty body');
  const source = Readable.fromWeb(response.body);
  source.on('data', chunk => onBytes(chunk.length));
  await pipeline(source, fs.createWriteStream(file, { flags: 'a' }), { signal });
}

async function mergeAndVerify(files, destination, expectedHash, algorithm) {
  const assembled = `${destination}.assembling`;
  const output = fs.createWriteStream(assembled, { flags: 'w' });
  const digest = crypto.createHash(algorithm);
  try {
    for (const file of files) {
      for await (const chunk of fs.createReadStream(file)) {
        digest.update(chunk);
        if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.once('error', reject); });
    if (digest.digest('hex').toLowerCase() !== expectedHash.toLowerCase()) {
      throw new IntegrityError('Downloaded artifact does not match the official checksum');
    }
    await fsp.rename(assembled, destination);
    for (const file of files) await fsp.rm(file, { force: true });
  } catch (error) {
    output.destroy();
    await fsp.rm(assembled, { force: true });
    throw error;
  }
}

async function downloadFile({ urls, destination, hash, algorithm = 'sha256', signal, onProgress = () => {}, onSourceFallback, fetchImpl = fetch, maxConnections = 4 }) {
  if (!Array.isArray(urls) || !urls.length || !/^[a-f0-9]{64}$|^[a-f0-9]{128}$/i.test(hash)) {
    throw new Error('A verified download source and checksum are required');
  }
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const connectionLimit = Math.min(4, Math.max(1, Math.floor(maxConnections)));
  let lastError;
  for (let sourceIndex = 0; sourceIndex < urls.length; sourceIndex++) {
    const url = urls[sourceIndex];
    if (!/^https:\/\//.test(url) && !/^http:\/\/localhost(?::\d+)?\//.test(url) && !/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(url)) {
      throw new Error('Artifact URL must use HTTPS');
    }
    try {
      const { size, ranges, validator } = await probe(url, signal, fetchImpl);
      const manifestPath = `${destination}.parts.json`;
      const identity = { url, hash: hash.toLowerCase(), algorithm, size, ranges, validator };
      const prior = await fsp.readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null);
      if (!size || !ranges || JSON.stringify(prior) !== JSON.stringify(identity)) {
        await clearParts(destination);
        await fsp.writeFile(manifestPath, JSON.stringify(identity));
      }
      const count = ranges && size >= 1024 * 1024 ? connectionLimit : 1;
      const segments = Array.from({ length: count }, (_, index) => {
        const begin = Math.floor(size * index / count);
        const end = index === count - 1 ? size - 1 : Math.floor(size * (index + 1) / count) - 1;
        return { begin, end, file: `${destination}.part-${index}` };
      });
      let received = 0;
      for (const segment of segments) {
        const existing = (await fsp.stat(segment.file).catch(() => null))?.size || 0;
        const length = segment.end - segment.begin + 1;
        if (size && existing > length) await fsp.truncate(segment.file, 0);
        else received += existing;
      }
      onProgress(size ? received / size : 0);
      await Promise.all(segments.map(async segment => {
        const existing = (await fsp.stat(segment.file).catch(() => null))?.size || 0;
        if (size && existing === segment.end - segment.begin + 1) return;
        await appendResponse(url, segment.file, count === 1 && !ranges ? 0 : segment.begin + existing, segment.end, size, signal, fetchImpl, bytes => {
          received += bytes;
          onProgress(size ? Math.min(1, received / size) : 0);
        }, count > 1 || (ranges && existing > 0));
      }));
      if (size) {
        for (const segment of segments) {
          const actual = (await fsp.stat(segment.file)).size;
          if (actual !== segment.end - segment.begin + 1) throw new Error('Download ended before the expected size');
        }
      }
      await mergeAndVerify(segments.map(segment => segment.file), destination, hash, algorithm);
      await fsp.rm(manifestPath, { force: true });
      onProgress(1);
      return { url, size };
    } catch (error) {
      if (isAbort(error) || signal?.aborted) throw error;
      lastError = error;
      if (sourceIndex < urls.length - 1 && onSourceFallback) {
        try {
          await onSourceFallback({ sourceIndex, failedUrl: url, nextUrl: urls[sourceIndex + 1], error });
        } catch (confirmationError) {
          await clearParts(destination);
          throw confirmationError;
        }
      }
      if (error instanceof IntegrityError || sourceIndex < urls.length - 1) await clearParts(destination);
    }
  }
  throw lastError;
}

module.exports = { downloadFile, IntegrityError, clearParts };
