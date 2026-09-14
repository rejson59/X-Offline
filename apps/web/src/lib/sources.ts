/**
 * Źródła danych. Świadomie bez płatnego API X: korzystamy z publicznych endpointów
 * syndykacji (tych samych, które zasilają osadzone posty na stronach trzecich).
 * Są nieudokumentowane i dawkowane — dlatego wszystko trafia do cache'u i działa potem bez sieci.
 */
import { apiBase, fetchText, isNative } from './transport';
import { normalizeTweets, parseNextData, syndicationToken, tweetIdFromUrl } from './normalize';
import { useSettings } from './store';
import { demoPostsFor } from './demo';
import type { PostRecord } from './types';

export const UPSTREAM = {
  timelineJson: (handle: string) =>
    `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}&with_replies=false&count=100`,
  timelineHtml: (handle: string) =>
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
  tweet: (id: string) =>
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=pl`,
};

export type UpstreamId = 'syndication-json' | 'syndication-html' | 'tweet-result' | 'demo' | 'none';

export interface FetchResult {
  posts: PostRecord[];
  upstream: UpstreamId;
  error?: string;
  hint?: string;
}

const handle = (raw: string) => raw.trim().replace(/^@/, '').replace(/^https?:\/\/(x|twitter)\.com\//, '').replace(/\/.*$/, '');
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function allowDemoFallback(): boolean {
  const mode = useSettings.getState().settings.sourceMode;
  return mode === 'auto' || mode === 'demo';
}

/** Ostatnie posty publicznego profilu. */
export async function fetchProfile(handleRaw: string, count = 25): Promise<FetchResult> {
  const h = handle(handleRaw);
  if (!HANDLE_RE.test(h)) {
    return { posts: [], upstream: 'none', error: `Niepoprawna nazwa profilu: ${h || '(pusto)'}` };
  }

  const mode = useSettings.getState().settings.sourceMode;
  if (mode !== 'demo') {
    // 0) Własny serwer proxy — buforuje odpowiedzi i łączy oba endpointy i zwraca { upstream, payload }.
    const api = apiBase();
    if (api || !isNative()) {
      try {
        const text = await fetchText(`${api || ''}/api/timeline/${encodeURIComponent(h)}?count=${count}`);
        const parsed = JSON.parse(text) as { upstream?: string; isJson?: boolean; payload?: unknown };
        let payload: unknown = parsed.payload ?? parsed;
        // Proxy może zwrócić HTML osadzonego timeline — wyciągamy z niego JSON.
        if (typeof payload === 'string') payload = parseNextData(payload) ?? payload;
        const posts = normalizeTweets(payload, 'syndication', { handle: h, count, dropReplies: true });
        if (posts.length) {
          return { posts, upstream: parsed.upstream === 'syndication-html' ? 'syndication-html' : 'syndication-json' };
        }
      } catch {
        /* proxy milczy → spróbuj wprost */
      }
    }
    // 1) JSON (szybki, jeśli X nadal go wystawia)
    try {
      const text = await fetchText(UPSTREAM.timelineJson(h));
      const payload = JSON.parse(text);
      const posts = normalizeTweets(payload, 'syndication', { handle: h, count, dropReplies: true });
      if (posts.length) return { posts, upstream: 'syndication-json' };
    } catch {
      /* spróbuj HTML */
    }
    // 2) Strona osadzonego timeline z JSON-em w __NEXT_DATA__
    try {
      const html = await fetchText(UPSTREAM.timelineHtml(h));
      const next = parseNextData(html);
      const posts = normalizeTweets(next ?? html, 'syndication', { handle: h, count, dropReplies: true });
      if (posts.length) return { posts, upstream: 'syndication-html' };
      if (/Nothing to see here/i.test(html)) {
        return {
          posts: [],
          upstream: 'none',
          error: `X zwrócił „Nothing to see here” dla @${h}.`,
          hint: 'Osadzone timeline bywają wymagające (konto bez weryfikacji / limit IP). W ustawieniach przełącz źródło na serwer proxy albo pobierz pojedyncze linki.',
        };
      }
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (allowDemoFallback()) {
        const demo = demoPostsFor(h, count);
        if (demo.length) return { posts: demo, upstream: 'demo', error: message };
      }
      return {
        posts: [],
        upstream: allowDemoFallback() ? 'demo' : 'none',
        error: message,
        hint:
          'Przeglądarka blokuje zapytania do X (CORS). Uruchom serwer proxy (npm run dev:server) albo w ustawieniach podaj adres własnego proxy — w APK ten krok pomijasz.',
      };
    }
  }

  if (allowDemoFallback()) {
    const demo = demoPostsFor(h, count);
    if (demo.length) return { posts: demo, upstream: 'demo' };
    return {
      posts: [],
      upstream: 'demo',
      error: `Brak postów demo dla @${h}.`,
      hint: 'Tryb demo ma 6 kont: kasia_koduje, silesia_dev, orbita_pl, foto_wegierek, low_bitrate, x_offline.',
    };
  }
  return { posts: [], upstream: 'none', error: `Nie udało się pobrać @${h}.` };
}

/** Pobieranie po linkach — działa dla każdego publicznego posta, nie tylko obserwowanych kont. */
export async function fetchPostsByLinks(links: string[], onEach?: (done: number, total: number) => void): Promise<FetchResult> {
  const ids = [...new Set(links.map(tweetIdFromUrl).filter(Boolean))] as string[];
  if (!ids.length) {
    return { posts: [], upstream: 'none', error: 'Brak poprawnych linków — wklej adresy w stylu x.com/uzytkownik/status/123' };
  }
  const posts: PostRecord[] = [];
  const errors: string[] = [];
  const upstream: UpstreamId = 'tweet-result';
  let i = 0;
  const api = apiBase();
  for (const id of ids) {
    try {
      const viaProxy = api ? await fetchText(`${api}/api/tweet/${id}`).catch(() => null) : null;
      const text = viaProxy ?? (await fetchText(UPSTREAM.tweet(id)));
      const payload = JSON.parse(text);
      const [post] = normalizeTweets(payload, 'syndication', { count: 1 });
      if (post) posts.push(post);
      else errors.push(`${id}: pusty wynik`);
    } catch (err) {
      errors.push(`${id}: ${String((err as Error).message ?? err)}`);
    }
    onEach?.(++i, ids.length);
    // Delikatnie, żeby nie wyzerować limitu po 5 requestach.
    await sleep(220 + Math.random() * 240);
  }
  if (!posts.length) {
    return {
      posts: [],
      upstream: 'none',
      error: `Żaden link się nie pobrał. ${errors[0] ?? ''}`,
      hint:
        'W przeglądarce potrzebne jest proxy (endpoint syndykacji nie wysyła nagłówków CORS). W APK działa bez proxy.',
    };
  }
  return { posts, upstream, error: errors.length ? `${errors.length} linków pominiętych` : undefined };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
