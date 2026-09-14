/**
 * X-Offline — proxy na Cloudflare Workers (alternatywa dla `server/index.js`).
 *
 * Po co: przeglądarka nie może zapytać publicznych endpointów syndykacji X, bo X nie wysyła
 * nagłówków CORS. Worker robi to za nią i przy okazji buforuje odpowiedzi (X dawkuje takie requests).
 *
 * Deploy (za darmo, bez karty):
 *   npm i -g wrangler
 *   wrangler init xoffline-proxy       # albo po prostu w dashboardzie: Create Worker
 *   wrangler deploy                    # z tym plikiem jako `main` (patrz wrangler.toml niżej)
 *
 * wrangler.toml:
 *   name = "xoffline-proxy"
 *   main = "cloudflare/worker.mjs"
 *   compatibility_date = "2026-01-01"
 *
 * Potem w apce: Ustawienia → Adres proxy → https://xoffline-proxy.<twoja-nazwa>.workers.dev
 */

const ALLOWED = new Set([
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
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Expose-Headers': 'x-upstream, cache-control, content-type',
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', ...CORS };

function allowed(urlString) {
  try {
    const u = new URL(urlString);
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED.has(u.hostname);
  } catch {
    return false;
  }
}

function tweetUrl(id) {
  const n = Number(id);
  const token = Number.isFinite(n) && n > 0 ? (((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '') || '1') : '1';
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=${token}&lang=pl`;
}

async function grab(url, { cf = 300 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
    cf: { cacheTtl: cf, cacheKey: url },
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get('content-type') ?? 'application/json' };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });

    if (url.pathname === '/api/health' || url.pathname === '/') {
      const probe = await grab('https://cdn.syndication.twimg.com/tweet-result?id=20&token=1', { cf: 3600 });
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'x-offline-proxy',
          runtime: 'cloudflare-worker',
          upstream: probe.status === 200 ? 'reachable' : `http-${probe.status}`,
          ts: new Date().toISOString(),
        }),
        { headers: JSON_HEADERS },
      );
    }

    // pobierz surową odpowiedź X (tekst/JSON) — używane przez /api/forward w aplikacji
    if (url.pathname === '/api/forward') {
      const target = url.searchParams.get('url') ?? '';
      if (!allowed(target)) return new Response(JSON.stringify({ error: 'host nie jest na liście' }), { status: 403, headers: JSON_HEADERS });
      const out = await grab(target);
      return new Response(out.status === 200 ? out.text : JSON.stringify({ error: `upstream ${out.status}` }), {
        status: out.status === 200 ? 200 : 502,
        headers: { ...CORS, 'content-type': out.contentType, 'cache-control': 'public, max-age=120' },
      });
    }

    // media (zdjęcia/klipy) — strumień do cache'u w IndexedDB
    if (url.pathname === '/api/media') {
      const target = url.searchParams.get('url') ?? '';
      if (!allowed(target)) return new Response(JSON.stringify({ error: 'host nie jest na liście' }), { status: 403, headers: JSON_HEADERS });
      const upstreamRes = await fetch(target, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 86400, cacheKey: target } });
      if (!upstreamRes.ok || !upstreamRes.body) {
        return new Response(JSON.stringify({ error: `upstream ${upstreamRes.status}` }), { status: 502, headers: JSON_HEADERS });
      }
      return new Response(upstreamRes.body, {
        headers: {
          ...CORS,
          'content-type': upstreamRes.headers.get('content-type') ?? 'application/octet-stream',
          'cache-control': 'public, max-age=604800, immutable',
        },
      });
    }

    // wygoda: /api/timeline/:handle?count= — łączy JSON i HTML endpointy
    if (url.pathname.startsWith('/api/timeline/')) {
      const handle = decodeURIComponent(url.pathname.slice('/api/timeline/'.length)).replace(/^@/, '');
      const count = Math.max(1, Math.min(100, Number(url.searchParams.get('count') ?? 25)));
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        return new Response(JSON.stringify({ error: 'zła nazwa profilu' }), { status: 400, headers: JSON_HEADERS });
      }
      const jsonUrl = `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}&with_replies=false&count=${count}`;
      const htmlUrl = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
      const attempts = [];
      for (const [id, target] of [
        ['syndication-json', jsonUrl],
        ['syndication-html', htmlUrl],
      ]) {
        const out = await grab(target);
        attempts.push(`${id}:${out.status}`);
        if (out.status !== 200) continue;
        if (id === 'syndication-json') {
          try {
            return new Response(JSON.stringify({ upstream: id, handle, count, isJson: true, payload: JSON.parse(out.text) }), {
              headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=120' },
            });
          } catch {
            /* spróbuj HTML */
          }
        } else {
          return new Response(JSON.stringify({ upstream: id, handle, count, isJson: false, payload: out.text }), {
            headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=120' },
          });
        }
      }
      return new Response(
        JSON.stringify({ error: 'brak odpowiedzi z X', attempts, hint: 'spróbuj /api/tweet/:id dla pojedynczych postów' }),
        { status: 502, headers: JSON_HEADERS },
      );
    }

    if (url.pathname.startsWith('/api/tweet/')) {
      const id = url.pathname.slice('/api/tweet/'.length).replace(/[^\d]/g, '');
      if (!id) return new Response(JSON.stringify({ error: 'potrzebne numeryczne ID' }), { status: 400, headers: JSON_HEADERS });
      const out = await grab(tweetUrl(id));
      if (out.status !== 200) {
        return new Response(JSON.stringify({ error: `upstream ${out.status}`, body: out.text.slice(0, 300) }), {
          status: out.status === 404 ? 404 : 502,
          headers: JSON_HEADERS,
        });
      }
      return new Response(out.text, { headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'public, max-age=120' } });
    }

    return new Response(JSON.stringify({ error: 'nie ma takiej ścieżki' }), { status: 404, headers: JSON_HEADERS });
  },
};
