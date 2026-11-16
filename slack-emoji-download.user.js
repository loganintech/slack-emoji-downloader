// ==UserScript==
// @name         Slack Custom Emoji Bulk Downloader
// @namespace    slack-emoji-download
// @version      1.0.0
// @description  Download every custom emoji in a Slack workspace as a zip, named :name: with the correct file extension.
// @match        https://*.slack.com/customize/emoji*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      self
// @connect      slack.com
// @connect      slack-edge.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config -------------------------------------------------------------
  const PAGE_SIZE = 100;          // emoji.adminList page size
  const CONCURRENCY = 6;          // parallel image downloads
  const MAX_RETRIES = 5;
  const INCLUDE_ALIAS_FILES = false; // true = also write a copy of the image under each alias name

  // ---- Helpers ------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: resolve,
        onerror: (e) => reject(new Error(`Network error: ${opts.url} ${e && e.error ? e.error : ''}`)),
        ontimeout: () => reject(new Error(`Timeout: ${opts.url}`)),
      });
    });
  }

  function getToken() {
    try {
      const t = unsafeWindow.boot_data && unsafeWindow.boot_data.api_token;
      if (t) return t;
    } catch (_) { /* fall through */ }
    for (const s of document.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/"api_token":"(xox[a-z]-[^"]+)"/);
      if (m) return m[1];
    }
    throw new Error('Could not find Slack API token on this page.');
  }

  async function callApi(method, params) {
    const body = new URLSearchParams(params).toString();
    for (let attempt = 0; ; attempt++) {
      const res = await gmRequest({
        method: 'POST',
        url: `${location.origin}/api/${method}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: body,
        responseType: 'json',
        timeout: 60000,
      });
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retry = parseInt(/retry-after:\s*(\d+)/i.exec(res.responseHeaders || '')?.[1] || '5', 10);
        await sleep(retry * 1000);
        continue;
      }
      const json = typeof res.response === 'object' && res.response ? res.response : JSON.parse(res.responseText);
      if (!json.ok) {
        if (json.error === 'ratelimited' && attempt < MAX_RETRIES) { await sleep(5000); continue; }
        throw new Error(`${method} failed: ${json.error}`);
      }
      return json;
    }
  }

  async function listAllEmoji(onProgress) {
    const token = getToken();
    const all = [];
    let page = 1, pages = 1;
    do {
      const json = await callApi('emoji.adminList', {
        token, page: String(page), count: String(PAGE_SIZE), sort_by: 'name', sort_dir: 'asc',
      });
      all.push(...json.emoji);
      pages = (json.paging && json.paging.pages) || 1;
      onProgress(`Listing emoji… page ${page}/${pages} (${all.length})`);
      page++;
    } while (page <= pages);
    return all;
  }

  // Determine the real file type from magic bytes; fall back to the URL extension.
  function detectExt(bytes, url) {
    const b = bytes;
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(url);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'bin';
  }

  async function fetchImage(url) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 60000, anonymous: true });
        if (res.status === 200) return new Uint8Array(res.response);
        if (attempt >= MAX_RETRIES) throw new Error(`HTTP ${res.status} for ${url}`);
      } catch (e) {
        if (attempt >= MAX_RETRIES) throw e;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }

  const safeName = (n) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');

  // ---- Minimal STORE-only zip writer (no dependencies) --------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  class ZipWriter {
    constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
    add(name, data) {
      const nameBytes = new TextEncoder().encode(name);
      const crc = crc32(data);
      const d = new Date();
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
      const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
      this.parts.push(lh.buffer, nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true);
      ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, this.offset, true);
      this.central.push(ch.buffer, nameBytes);

      this.offset += 30 + nameBytes.length + data.length;
      this.count++;
    }
    toBlob() {
      const cdSize = this.central.reduce((s, p) => s + p.byteLength, 0);
      const eocd = new DataView(new ArrayBuffer(22));
      eocd.setUint32(0, 0x06054b50, true);
      eocd.setUint16(8, this.count, true); eocd.setUint16(10, this.count, true);
      eocd.setUint32(12, cdSize, true); eocd.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, eocd.buffer], { type: 'application/zip' });
    }
  }

  // ---- Main ---------------------------------------------------------------
  async function run(setStatus) {
    const emoji = await listAllEmoji(setStatus);
    const originals = emoji.filter((e) => !e.is_alias);
    const aliases = emoji.filter((e) => e.is_alias);
    const byName = new Map(originals.map((e) => [e.name, e]));

    const jobs = originals.map((e) => ({ name: e.name, url: e.url }));
    if (INCLUDE_ALIAS_FILES) {
      for (const a of aliases) {
        const target = byName.get(a.alias_for);
        jobs.push({ name: a.name, url: (target && target.url) || a.url });
      }
    }

    const zip = new ZipWriter();
    const failures = [];
    const manifest = [];
    let done = 0, next = 0;

    async function worker() {
      while (next < jobs.length) {
        const job = jobs[next++];
        try {
          const bytes = await fetchImage(job.url);
          const ext = detectExt(bytes, job.url);
          const file = `${safeName(job.name)}.${ext}`;
          zip.add(`emoji/${file}`, bytes);
          manifest.push({ name: job.name, file, url: job.url });
        } catch (e) {
          failures.push({ name: job.name, url: job.url, error: String(e.message || e) });
        }
        done++;
        setStatus(`Downloading ${done}/${jobs.length}${failures.length ? ` (${failures.length} failed)` : ''}`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const enc = (o) => new TextEncoder().encode(JSON.stringify(o, null, 2));
    manifest.sort((a, b) => a.name.localeCompare(b.name));
    zip.add('emoji.json', enc(manifest));
    zip.add('aliases.json', enc(aliases.map((a) => ({ name: a.name, alias_for: a.alias_for }))));
    if (failures.length) zip.add('failures.json', enc(failures));

    setStatus('Building zip…');
    const blob = zip.toBlob();
    const host = location.hostname.split('.')[0];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${host}-slack-emoji.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);

    setStatus(`Done: ${manifest.length} emoji, ${aliases.length} aliases` +
      (failures.length ? `, ${failures.length} failed (see failures.json)` : ''));
  }

  // ---- UI -----------------------------------------------------------------
  const btn = document.createElement('button');
  btn.textContent = 'Download all emoji';
  Object.assign(btn.style, {
    position: 'fixed', bottom: '20px', right: '20px', zIndex: 2147483647,
    padding: '10px 16px', background: '#4a154b', color: '#fff', border: 'none',
    borderRadius: '6px', font: '600 14px/1.2 sans-serif', cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '360px', textAlign: 'left',
  });
  const setStatus = (t) => { btn.textContent = t; };
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.style.cursor = 'progress';
    try {
      await run(setStatus);
    } catch (e) {
      console.error('[slack-emoji-download]', e);
      setStatus(`Error: ${e.message || e} (click to retry)`);
    } finally {
      btn.disabled = false;
      btn.style.cursor = 'pointer';
    }
  });
  document.body.appendChild(btn);
})();
