#!/usr/bin/env node
/**
 * X-Offline proxy — minimalny serwer, który robi dokładnie dwie rzeczy:
 *
 *  1. `/api/forward?url=…` — pobiera odpowiedź z publicznych endpointów syndykacji X
 *     i oddaje ją przeglądarce z nagłówkami CORS (przeglądarka sama nie może, bo X nie
 *     wysyła Access-Control-Allow-Origin).
 *  2. `/api/media?url=…`   — streamuje zdjęcia/klipy z pb.twimg.com CDN, żeby dało się je
 *     zrzucić do IndexedDB (ten sam powód).
 *
 * Świadomie: bez logowania treści, bez ciasteczek, z allow-listą hostów i limitami,
 * żeby to nie był open proxy. Odpowiedzi buforuje w pamięci ( TTL ), bo endpointy X są dawkowane.
 *
 * Uruchomienie:  node index.js   (PORT=8787 domyślnie)
 */
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const CACHE_TTL = Number(process.env.CACHE_TTL ?? 5 * 60 * 1000);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_BYTES = Number(process.env.MAX_MEDIA_BYTES ?? 64 * 1024 * 1024);

/** Tylko hosty, z których apka realnie czyta. Bez tego to byłby open proxy. */
const ALLOWED_HOSTS = new Set([
  'cdn.syndication.twimg.com',
  'syndication.twitter.com',
  'syndication.twimg.com',
  'pbs.twimg.com',
  'video.twimg.com',
  'abs.twimg.com',
  'publish.twitter.com',
  'platform.twitter.com',
  'x.com',
  'twitter.com',
  'mobile.twitter.com',
]);

const UA =
  process.env.UPSTREAM_UA ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const cache = new Map();
const buckets = new Map();

function allowRate(ip) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 30, at: now };
  b.tokens = Math.min(30, b.tokens + ((now - b.at) / 1000) * 1.5);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function put(key, value) {
  cache.set(key, { ...value, at: Date.now() });
  if (cache.size > 400) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Expose-Headers': 'x-upstream, cache-control, content-type',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function isAllowed(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    return ALLOWED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

async function upstream(url, { binary = false, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: binary ? 'image/*, video/*, application/json;q=0.9, */*;q=0.5' : 'application/json, text/html;q=0.9, */*;q=0.5',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.6',
        'Accept-Encoding': 'gzip, deflate',
      },
    });
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k] = v;
    if (binary) return { status: res.status, headers, stream: res.body, contentType: headers['content-type'] };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_JSON_BYTES) return { status: 413, headers, text: JSON.stringify({ error: 'upstream too large' }) };
    let text = Buffer.from(buf).toString('utf8');
    if (/\bgzip\b/.test(headers['content-encoding'] ?? '')) {
      try {
        text = gunzipSync(Buffer.from(buf)).toString('utf8');
      } catch {
        /* już zdekodowane */
      }
    }
    return { status: res.status, headers, text, contentType: headers['content-type'] };
  } finally {
    clearTimeout(timer);
  }
}

function timelineUrls(handle, count) {
  return [
    {
      id: 'syndication-json',
      url: `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}&with_replies=false&count=${count}`,
      binary: false,
    },
    {
      id: 'syndication-html',
      url: `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
      binary: false,
    },
  ];
}

function tweetUrl(id) {
  const n = Number(id);
  const token = Number.isFinite(n) && n > 0 ? ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '') || '1' : '1';
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${token}&lang=pl`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const ip = req.socket.remoteAddress ?? '?';

  if (req.method === 'OPTIONS') return send(res, 204, '', { 'Access-Control-Allow-Methods': 'GET, OPTIONS' });

  if (url.pathname === '/api/health' || url.pathname === '/health') {
    let upstreamState = 'unknown';
    try {
      const probe = await upstream('https://cdn.syndication.twimg.com/tweet-result?id=20&token=1', { timeoutMs: 8000 });
      upstreamState = probe.status === 200 ? 'reachable' : `http-${probe.status}`;
    } catch (err) {
      upstreamState = `unreachable:${err?.name ?? 'err'}`;
    }
    return send(
      res,
      200,
      JSON.stringify({
        ok: true,
        service: 'x-offline-proxy',
        version: '0.1.0',
        upstream: upstreamState,
        cacheSize: cache.size,
        ts: new Date().toISOString(),
      }),
      { 'Cache-Control': 'no-store' },
    );
  }

  if (!allowRate(ip)) return send(res, 429, JSON.stringify({ error: 'Za dużo zapytań — odczekaj chwilę.' }), { 'Retry-After': '20' });

  if (url.pathname === '/api/forward') {
    const target = url.searchParams.get('url') ?? '';
    if (!isAllowed(target)) return send(res, 403, JSON.stringify({ error: 'Host poza allow-listą X-Offline.' }));
    const key = `f:${target}`;
    const hit = cached(key);
    if (hit) return send(res, 200, hit.body, { 'Content-Type': hit.contentType, 'X-Upstream': 'cache' });
    try {
      const out = await upstream(target);
      const body = out.status === 200 ? out.text : JSON.stringify({ error: `upstream ${out.status}`, body: out.text?.slice(0, 400) });
      if (out.status === 200) put(key, { body, contentType: out.contentType ?? 'application/json' });
      return send(res, out.status === 200 ? 200 : 502, body, {
        'Content-Type': out.status === 200 ? (out.contentType ?? 'application/json') : 'application/json; charset=utf-8',
        'X-Upstream': 'network',
      });
    } catch (err) {
      return send(res, 502, JSON.stringify({ error: 'Nie udało się sięgnąć do X.', detail: String(err?.message ?? err) }));
    }
  }

  if (url.pathname === '/api/media') {
    const target = url.searchParams.get('url') ?? '';
    if (!isAllowed(target)) return send(res, 403, JSON.stringify({ error: 'Host poza allow-listą X-Offline.' }));
    try {
      const out = await upstream(target, { binary: true, timeoutMs: 40000 });
      if (out.status !== 200 || !out.stream) return send(res, 502, JSON.stringify({ error: `upstream ${out.status}` }));
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': out.contentType ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=604800, immutable',
        'X-Upstream': 'network',
      });
      let written = 0;
      const reader = out.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value?.byteLength ?? 0;
        if (written > MAX_MEDIA_BYTES) {
          res.destroy();
          return;
        }
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (err) {
      return send(res, 502, JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }

  if (url.pathname.startsWith('/api/timeline/')) {
    const handle = decodeURIComponent(url.pathname.slice('/api/timeline/'.length)).replace(/^@/, '');
    const count = Math.max(1, Math.min(100, Number(url.searchParams.get('count') ?? 25)));
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return send(res, 400, JSON.stringify({ error: 'Zła nazwa profilu.' }));
    const key = `t:${handle}:${count}`;
    const hit = cached(key);
    if (hit) return send(res, 200, hit.body, { 'Content-Type': 'application/json', 'X-Upstream': 'cache' });
    const attempts = [];
    for (const candidate of timelineUrls(handle, count)) {
      try {
        const out = await upstream(candidate.url);
        attempts.push(`${candidate.id}:${out.status}`);
        if (out.status !== 200) continue;
        const isJson = /^application\/json/.test(out.contentType ?? '');
        const payload = isJson ? JSON.parse(out.text) : out.text;
        const body = JSON.stringify({ upstream: candidate.id, handle, count, isJson, payload });
        put(key, { body, contentType: 'application/json' });
        return send(res, 200, body, { 'Content-Type': 'application/json', 'X-Upstream': 'network' });
      } catch (err) {
        attempts.push(`${candidate.id}:err`);
        void err;
      }
    }
    return send(
      res,
      502,
      JSON.stringify({
        error: 'Żaden publiczny endpoint timeline nie odpowiedział.',
        attempts,
        hint: 'X często zwraca „Nothing to see here” bez zalogowanej sesji. Spróbuj pobierania po linkach (/api/tweet/:id).',
      }),
    );
  }

  if (url.pathname.startsWith('/api/tweet/')) {
    const id = url.pathname.slice('/api/tweet/'.length).replace(/[^\d]/g, '');
    if (!id) return send(res, 400, JSON.stringify({ error: 'Potrzebne numeryczne ID posta.' }));
    const key = `tw:${id}`;
    const hit = cached(key);
    if (hit) return send(res, 200, hit.body, { 'Content-Type': 'application/json', 'X-Upstream': 'cache' });
    try {
      const out = await upstream(tweetUrl(id));
      if (out.status !== 200) {
        return send(res, out.status === 404 ? 404 : 502, JSON.stringify({ error: `upstream ${out.status}`, body: out.text?.slice(0, 300) }));
      }
      put(key, { body: out.text, contentType: 'application/json' });
      return send(res, 200, out.text, { 'Content-Type': 'application/json', 'X-Upstream': 'network' });
    } catch (err) {
      return send(res, 502, JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }

  return send(res, 404, JSON.stringify({ error: 'Nie ma takiej ścieżki.', endpoints: ['/api/health', '/api/forward', '/api/media', '/api/timeline/:handle', '/api/tweet/:id'] }));
});

server.listen(PORT, HOST, () => {
  console.log(`X-Offline proxy → http://${HOST}:${PORT}`);
  console.log(`  health:   curl localhost:${PORT}/api/health`);
  console.log(`  allow-lista hostów: ${[...ALLOWED_HOSTS].length}`);
});
