/**
 * Źródła danych. Bez płatnego API X: korzystamy z publicznych endpointów syndykacji
 * (tych samych, które zasilają osadzone posty na stronach trzecich) oraz — w APK —
 * z tego, co wstrzyknięty zbieracz wyłapie z sesji użytkownika.
 *
 * Tu nie ma żadnych danych zastępczych: jeśli sieć zawiedzie, zwracamy pusty wynik
 * i konkretny powód, a apka pokazuje co zrobić (proxy / APK / link bezpośredni).
 */
import { apiBase, fetchText, isNative, sleep, TransportError, type Transport } from './transport';
import { normalizeTweets, parseNextData, syndicationToken, tweetIdFromUrl } from './normalize';
import { useSettings } from './store';
import { logDiag } from './diagnostics';
import type { PostOrigin, PostRecord } from './types';

export const UPSTREAM = {
  timelineJson: (handle: string) =>
    `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(handle)}&with_replies=false&count=100`,
  timelineHtml: (handle: string) =>
    `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`,
  tweet: (id: string) =>
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=pl`,
};

export type UpstreamId = 'syndication-json' | 'syndication-html' | 'tweet-result' | 'none';

/** Dlaczego się nie udało — po tym UI dobiera podpowiedź. */
export type FetchFailure = 'offline' | 'cors' | 'proxy-down' | 'blocked' | 'empty' | 'bad-input' | 'error';

export interface FetchResult {
  posts: PostRecord[];
  upstream: UpstreamId;
  origin: PostOrigin;
  error?: string;
  hint?: string;
  failure?: FetchFailure;
}

const stripHandle = (raw: string) =>
  raw
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/[/?#].*$/, '');

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Wyciąga nazwę profilu z tego, co wklei człowiek: `@nasa`, link, `nasa/status/123`. */
export function resolveHandle(raw: string): string | null {
  const h = stripHandle(raw);
  return HANDLE_RE.test(h) ? h : null;
}

function failureFrom(err: unknown): { failure: FetchFailure; message: string } {
  const e = err as TransportError & { message?: string };
  const message = e?.message ?? String(err);
  const transport: Transport | undefined = e?.transport;
  if (/HTTP 4\d\d/.test(message)) return { failure: 'blocked', message };
  if (transport === 'direct') return { failure: 'cors', message };
  if (/failed to fetch|networkerror|load failed|ERR_/i.test(message)) return { failure: 'cors', message };
  return { failure: 'error', message };
}

function hintFor(failure: FetchFailure): string {
  switch (failure) {
    case 'cors':
      return isNative() ?
          'Telefon nie ma teraz łącza z X — sprawdź internet w telefonie.'
        : 'Przeglądarka nie może zapytać X wprost (CORS). Uruchom serwer proxy (npm run dev:server), wskaż własny adres w Ustawieniach albo zainstaluj APK — w niej pobieranie idzie siecią natywną.';
    case 'proxy-down':
      return 'Serwer proxy nie odpowiada. Odpal `npm run dev:server` (albo wystaw cloudflare/worker.mjs) i wpisz jego adres w Ustawieniach.';
    case 'blocked':
      return 'X odmówił odpowiedzi (limit albo konto/osłona). Odczekaj chwilę i spróbuj ponownie — to samo dzieje się przy zbyt częstym odpytywaniu.';
    case 'offline':
      return 'Nie ma łącza — poczytaj to, co już jest w „Zapisanych”.';
    default:
      return 'Spróbuj ponownie za moment; jeśli powtarza się przy każdym profilu, zobacz dziennik w Ustawienia → Diagnostyka.';
  }
}

/** Ostatnie posty publicznego profilu. */
export async function fetchProfile(handleRaw: string, count = 25): Promise<FetchResult> {
  const h = resolveHandle(handleRaw);
  if (!h) {
    return {
      posts: [],
      upstream: 'none',
      origin: 'profile',
      failure: 'bad-input',
      error: `Niepoprawna nazwa profilu: ${handleRaw || '(pusto)'}`,
      hint: 'Podaj nazwę użytkownika (litery, cyfry, podkreślenie — do 15 znaków) albo link do profilu.',
    };
  }
  if (!useSettings.getState().online) {
    return { posts: [], upstream: 'none', origin: 'profile', failure: 'offline', error: 'Brak łącza', hint: hintFor('offline') };
  }

  const errors: string[] = [];
  const api = apiBase();

  // 0) Własny serwer proxy — buforuje odpowiedzi i łączy oba endpointy, zwraca { upstream, payload }.
  if (api || !isNative()) {
    try {
      const text = await fetchText(`${api || ''}/api/timeline/${encodeURIComponent(h)}?count=${count}`);
      const parsed = JSON.parse(text) as { upstream?: string; payload?: unknown };
      let payload: unknown = parsed.payload ?? parsed;
      if (typeof payload === 'string') payload = parseNextData(payload) ?? payload;
      const posts = normalizeTweets(payload, 'syndication', { handle: h, count, dropReplies: true });
      if (posts.length) {
        return {
          posts: posts.map((p) => ({ ...p, origin: 'profile' as PostOrigin })),
          upstream: parsed.upstream === 'syndication-html' ? 'syndication-html' : 'syndication-json',
          origin: 'profile',
        };
      }
      errors.push('proxy: pusta odpowiedź');
    } catch (err) {
      errors.push(`proxy: ${(err as Error).message}`);
    }
  }

  // 1) JSON (szybki, jeśli X nadal go wystawia).
  try {
    const text = await fetchText(UPSTREAM.timelineJson(h));
    const posts = normalizeTweets(JSON.parse(text), 'syndication', { handle: h, count, dropReplies: true });
    if (posts.length) return { posts: posts.map((p) => ({ ...p, origin: 'profile' })), upstream: 'syndication-json', origin: 'profile' };
    errors.push('syndication-json: pusty wynik');
  } catch (err) {
    errors.push(`syndication-json: ${(err as Error).message}`);
  }

  // 2) Strona osadzonego timeline z JSON-em w __NEXT_DATA__.
  try {
    const html = await fetchText(UPSTREAM.timelineHtml(h));
    const next = parseNextData(html);
    const posts = normalizeTweets(next ?? html, 'syndication', { handle: h, count, dropReplies: true });
    if (posts.length) return { posts: posts.map((p) => ({ ...p, origin: 'profile' })), upstream: 'syndication-html', origin: 'profile' };
    if (/Nothing to see here/i.test(html)) {
      return {
        posts: [],
        upstream: 'none',
        origin: 'profile',
        failure: 'blocked',
        error: `X zwrócił „Nothing to see here” dla @${h}.`,
        hint: `Osadzone timeline bywają kapryśne (limit IP, świeże konto, region). Sprawdź @${h} w natywnym podglądzie X — tam zbieramy to, co widzisz, bez tych limitów.`,
      };
    }
    errors.push('syndication-html: pusty wynik');
  } catch (err) {
    errors.push(`syndication-html: ${(err as Error).message}`);
  }

  const { failure, message } = failureFrom(new Error(errors.at(-1) ?? 'nieznany błąd'));
  const proxyDown = !isNative() && !api;
  logDiag('warn', `@${h}: nie udało się pobrać postów`, errors.join('\n'));
  return {
    posts: [],
    upstream: 'none',
    origin: 'profile',
    failure: proxyDown ? 'proxy-down' : failure,
    error: `Nie udało się pobrać @${h}: ${message}`,
    hint: hintFor(proxyDown ? 'proxy-down' : failure),
  };
}

/** Pobieranie po linkach — działa dla każdego publicznego posta, nie tylko obserwowanych kont. */
export async function fetchPostsByLinks(
  links: string[],
  onEach?: (done: number, total: number) => void,
): Promise<FetchResult> {
  const ids = [...new Set(links.map(tweetIdFromUrl).filter(Boolean))] as string[];
  if (!ids.length) {
    return {
      posts: [],
      upstream: 'none',
      origin: 'links',
      failure: 'bad-input',
      error: 'Brak poprawnych linków',
      hint: 'Wklej adresy w stylu https://x.com/uzytkownik/status/1234567890123456789 (albo same identyfikatory).',
    };
  }
  if (!useSettings.getState().online) {
    return { posts: [], upstream: 'none', origin: 'links', failure: 'offline', error: 'Brak łącza', hint: hintFor('offline') };
  }

  const posts: PostRecord[] = [];
  const errors: string[] = [];
  const api = apiBase();
  let i = 0;
  for (const id of ids) {
    try {
      const viaProxy = api ? await fetchText(`${api}/api/tweet/${id}`).catch(() => null) : null;
      const text = viaProxy ?? (await fetchText(UPSTREAM.tweet(id)));
      const [post] = normalizeTweets(JSON.parse(text), 'syndication', { count: 1 });
      if (post) posts.push({ ...post, origin: 'links' });
      else errors.push(`${id}: pusty wynik`);
    } catch (err) {
      errors.push(`${id}: ${(err as Error).message}`);
    }
    onEach?.(++i, ids.length);
    // Delikatnie, żeby nie zerować limitu: syndykacja dawkuje odpowiedzi.
    await sleep(220 + Math.random() * 240);
  }
  if (!posts.length) {
    const { failure } = failureFrom(new Error(errors[0] ?? ''));
    logDiag('warn', 'import linków nie zwrócił nic', errors.join('\n'));
    return {
      posts: [],
      upstream: 'none',
      origin: 'links',
      failure: failure === 'error' ? 'cors' : failure,
      error: `Żaden link się nie pobrał. ${errors[0] ?? ''}`,
      hint: hintFor(failure === 'error' ? 'cors' : failure),
    };
  }
  return {
    posts,
    upstream: 'tweet-result',
    origin: 'links',
    error: errors.length ? `${errors.length} z ${ids.length} linków pominiętych` : undefined,
  };
}

/** Pojedynczy post po identyfikatorze (używa go też import z pliku i kolejka akcji). */
export async function fetchTweetById(id: string): Promise<PostRecord | null> {
  const api = apiBase();
  const viaProxy = api ? await fetchText(`${api}/api/tweet/${id}`).catch(() => null) : null;
  const text = viaProxy ?? (await fetchText(UPSTREAM.tweet(id)));
  const [post] = normalizeTweets(JSON.parse(text), 'syndication', { count: 1 });
  return post ? { ...post, origin: 'links' } : null;
}
