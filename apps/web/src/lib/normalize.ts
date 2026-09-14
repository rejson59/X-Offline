/**
 * Normalizery surowych odpowiedzi z publicznych endpointów syndykacji X.
 * Format nie jest udokumentowany i może się zmienić — dlatego wszystko jest defensywne
 * i zwraca `null` zamiast rzucać, gdy czegoś brakuje.
 */
import type { MediaItem, PostRecord, PostSource } from './types';

type Raw = Record<string, any>;

/** Publiczny token wymagany przez cdn.syndication.twimg.com/tweet-result. */
export function syndicationToken(id: string): string {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return '1';
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '') || '1';
}

export function tweetIdFromUrl(url: string): string | null {
  const m =
    url.match(/(?:twitter\.com|x\.com)\/(?:[A-Za-z0-9_]+|i\/web)\/status(?:es)?\/(\d{1,25})/i) ??
    url.match(/(?:^|[?&])id=(\d{4,25})/) ??
    url.match(/^\s*(\d{15,20})\s*$/);
  return m ? m[1] : null;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

function pickVideoVariant(variants: Raw[] | undefined, preferHd: boolean): string | undefined {
  if (!variants?.length) return undefined;
  const mp4 = variants.filter((v) => /video\/mp4/.test(String(v.content_type)));
  const pool = mp4.length ? mp4 : variants;
  const sorted = [...pool].sort((a, b) => num(b.bitrate) - num(a.bitrate));
  // Offline ma ważyć rozsądnie: bierzemy ~środek, nie najwyższy bitrate.
  if (preferHd) return sorted[0]?.url;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length / 2));
  return (sorted[idx] ?? sorted[0])?.url;
}

function mediaFrom(raw: Raw): MediaItem[] {
  const out: MediaItem[] = [];
  const details: Raw[] = raw.mediaDetails ?? raw.extended_entities?.media ?? raw.entities?.media ?? [];
  for (const m of details) {
    const type = String(m.type ?? '').toLowerCase();
    const url: string | undefined = m.media_url_https ?? m.media_url ?? m.url;
    if (!url) continue;
    if (type === 'photo') {
      out.push({
        kind: 'image',
        url: `${url}${url.includes('?') ? '' : '?name=large'}`,
        width: num(m.sizes?.large?.w) || undefined,
        height: num(m.sizes?.large?.h) || undefined,
        alt: m.extendedAltText ?? m.altText ?? undefined,
      });
    } else if (type === 'animated_gif') {
      out.push({
        kind: 'gif',
        url: pickVideoVariant(m.video_info?.variants, false) ?? url,
        poster: url,
        width: num(m.original_info?.width) || undefined,
        height: num(m.original_info?.height) || undefined,
      });
    } else if (type === 'video') {
      const url2 = pickVideoVariant(m.video_info?.variants, false);
      if (!url2) continue;
      out.push({
        kind: 'video',
        url: url2,
        poster: `${m.media_url_https ?? url}?name=large`,
        width: num(m.original_info?.width) || undefined,
        height: num(m.original_info?.height) || undefined,
        durationMs: num(m.duration_millis) || undefined,
      });
    }
  }
  // Zdjęcia w tweet-result bywają w osobnym polu `photos`.
  if (!out.length && Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      if (p?.url) out.push({ kind: 'image', url: p.url, alt: p.altText ?? undefined });
    }
  }
  // Pojedyncze wideo (tweet-result).
  if (!out.length && raw.video?.variants) {
    const url = pickVideoVariant(raw.video.variants, false);
    if (url) out.push({ kind: 'video', url, poster: raw.video.poster });
  }
  return out.filter((m) => /^https?:/.test(m.url));
}

function cardFrom(raw: Raw): PostRecord['card'] {
  const c = raw.card ?? raw.quoted_tweet?.card;
  const values: Raw = c?.values ?? {};
  const get = (k: string) => values[k]?.stringValue ?? values[k]?.htmlValue;
  if (!get('title1') && !c?.url) return undefined;
  return {
    url: c?.url ?? get('url') ?? '',
    title: get('title1') ?? get('title') ?? c?.title ?? 'Link',
    domain: get('url1') ?? c?.domain ?? safeDomain(c?.url ?? ''),
    brief: get('description1') ?? get('description'),
    image: values.image_value?.imageUrl ? String(values.image_value.imageUrl) : c?.img,
  };
}

export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function extractText(raw: Raw): string {
  const note = raw.note_tweet ?? raw.note_tweet_compat;
  const base: string =
    (typeof note?.text === 'string' ? note.text : undefined) ??
    (typeof raw.text === 'string' ? raw.text : '') ??
    '';
  // Długie posty: syndykacja ucina na 280 znakach i wystawia `display_text_range`.
  if (typeof raw.article?.title === 'string') {
    return `${base}\n\n📄 ${raw.article.title}`.trim();
  }
  return base
    .replace(/https?:\/\/pic\.twitter\.com\/\w+/g, '')
    .replace(/\s+https?:$/g, '')
    .trim();
}

function tagsFrom(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#([\p{L}\p{N}_]+)|@([A-Za-z0-9_]{2,15})/gu)) {
    out.add((m[1] ? `#${m[1]}` : `@${m[2]}`).toLowerCase());
  }
  return [...out].slice(0, 24);
}

export interface NormalizedPost extends PostRecord {}

export function normalizeTweet(raw: Raw, source: PostSource, fetchedFrom?: string): NormalizedPost | null {
  if (!raw || typeof raw !== 'object') return null;
  const core: Raw = raw.tweet ?? raw.legacy ?? raw;
  const id: string = String(core.id_str ?? core.id ?? '');
  if (!id) return null;
  const user: Raw = core.user ?? core.author ?? core.__raw__?.core?.user_results?.result?.legacy ?? {};
  const handle: string = String(user.screen_name ?? user.username ?? fetchedFrom ?? 'x');
  const text = extractText(core);
  if (!text && !(core.mediaDetails?.length || core.photos?.length)) return null;
  const created = core.created_at ?? core.created_at_millis;
  const createdAt =
    typeof created === 'number' ? created : created ? Date.parse(String(created)) : Date.now();
  const userMentions: Raw[] = core.entities?.user_mentions ?? [];
  return {
    id: `${source}:${id}`,
    nativeId: id,
    source,
    url:
      core.__url ??
      (user.screen_name ? `https://x.com/${user.screen_name}/status/${id}` : undefined),
    authorHandle: handle,
    authorName: String(user.name ?? user.login ?? handle),
    authorAvatar: user.profile_image_url_https
      ? String(user.profile_image_url_https).replace('_normal', '_400x400')
      : user.avatar_url,
    text,
    lang: core.lang ?? undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    savedAt: null,
    stats: {
      replies: num(core.conversation_count ?? core.reply_count),
      reposts: num(core.retweet_count ?? core.retweed_count ?? 0),
      likes: num(core.favorite_count),
      views: core.views?.count ? num(core.views.count) : undefined,
    },
    media: mediaFrom(core),
    card: cardFrom(core),
    isReply: Boolean(core.in_reply_to_status_id_str && !core.self_thread),
    retweetedBy: core.retweeted_status_result
      ? String(core.retweeted_status_result.user?.name ?? '')
      : undefined,
    sizeBytes: 0,
    tags: tagsFrom(text),
    fetchedFrom: fetchedFrom ?? (userMentions.length ? handle : undefined),
  };
}

/** Wyciąga wpisy z różnych kształtów odpowiedzi (JSON timeline, __NEXT_DATA__, surowa strona). */
export function extractTweetList(payload: unknown): Raw[] {
  const p = payload as Raw;
  if (!p) return [];
  if (Array.isArray(p)) return p as Raw[];
  if (Array.isArray(p.timeline)) return p.timeline.map((e: Raw) => e?.content?.tweet ?? e).filter(Boolean);
  if (Array.isArray(p.entries)) return p.entries.map((e: Raw) => e?.content?.tweet ?? e).filter(Boolean);
  const tl = p.props?.pageProps?.timeline?.entries;
  if (Array.isArray(tl)) return tl.map((e: Raw) => e?.content?.tweet ?? e).filter(Boolean);
  const instructions =
    p.instructions ?? p.data?.timeline_v2?.timeline?.instructions ?? p.data?.threaded_conversation?.timeline;
  if (Array.isArray(instructions)) {
    const out: Raw[] = [];
    for (const ins of instructions) {
      const entries = ins.entries ?? ins.content?.items ?? [];
      for (const e of entries) {
        const item = e?.content?.itemContent?.tweet_results?.result ?? {};
        const t = e?.content?.tweet ?? item.tweet ?? item.legacy ?? item;
        if (t && (t.id_str || t.full_text)) out.push(t);
      }
    }
    return out;
  }
  // Pojedynczy tweet.
  return p.id_str || p.tweet ? [p] : [];
}

export function parseNextData(html: string): Raw | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export function normalizeTweets(
  payload: unknown,
  source: PostSource,
  opts: { handle?: string; count?: number; dropReplies?: boolean } = {},
): NormalizedPost[] {
  const raws = extractTweetList(payload);
  const seen = new Set<string>();
  const posts: NormalizedPost[] = [];
  for (const raw of raws) {
    const post = normalizeTweet(raw, source, opts.handle);
    if (!post) continue;
    if (opts.dropReplies && post.isReply) continue;
    if (post.retweetedBy) continue; // tylko główne posty, bez retweetów
    if (seen.has(post.nativeId)) continue;
    seen.add(post.nativeId);
    if (opts.handle && post.authorHandle.toLowerCase() !== opts.handle.toLowerCase()) continue;
    posts.push(post);
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return typeof opts.count === 'number' ? posts.slice(0, opts.count) : posts;
}

