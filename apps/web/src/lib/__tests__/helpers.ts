/**
 * Wspólne narzędzia testów. Świadomie NIE używamy tu plików demo — budujemy posty
 * z takich samych kształtów JSON, jakie realnie przychodzą z X (syndykacja + GraphQL).
 */
import { vi } from 'vitest';
import { normalizeTweets } from '@/lib/normalize';
import type { NormalizedPost } from '@/lib/normalize';
import type { PostRecord } from '@/lib/types';

let seq = 0;

/** Post „z syndykacji” w realnym kształcie tweet-result. */
export function syndicationTweet(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    __typename: 'Tweet',
    id_str: String(7000000000000000000n + BigInt(seq)),
    text: `Post numer ${seq} o offline-first #offline`,
    created_at: new Date(Date.now() - seq * 60_000).toISOString(),
    lang: 'pl',
    favorite_count: 10 + seq,
    conversation_count: seq,
    user: {
      id_str: String(100 + seq),
      name: 'Orbita',
      screen_name: 'orbita_pl',
      profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
    },
    ...over,
  };
}

/** Post z GraphQL (to, co wyłapuje natywny zbieracz w APK). */
export function graphqlTweet(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  const id = String(8000000000000000000n + BigInt(seq));
  return {
    rest_id: id,
    core: {
      user_results: {
        result: {
          legacy: {
            name: 'Orbita',
            screen_name: 'orbita_pl',
            profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
          },
        },
      },
    },
    legacy: {
      id_str: id,
      full_text: `GraphQL post ${seq} #offline`,
      created_at: 'Tue Sep 01 09:12:00 +0000 2026',
      favorite_count: 3,
      ...over,
    },
  };
}

export function envelope(tweets: Record<string, unknown>[], source = 'live-scroll'): Record<string, unknown> {
  return { source, collectedAt: Date.now(), tweets };
}

export function postsFrom(tweets: Record<string, unknown>[], over: Partial<PostRecord> = {}): NormalizedPost[] {
  return normalizeTweets({ tweets }, 'syndication', { count: 100 }).map((p) => ({ ...p, ...over }));
}

export function makePost(over: Partial<PostRecord> = {}): PostRecord {
  seq++;
  const id = String(9000000000000000000n + BigInt(seq));
  return {
    id: `syndication:${id}`,
    nativeId: id,
    source: 'syndication',
    authorHandle: 'orbita_pl',
    authorName: 'Orbita',
    text: `Post testowy ${seq} #offline`,
    createdAt: Date.now() - seq * 1000,
    savedAt: null,
    readAt: null,
    stats: { replies: 0, reposts: 0, likes: seq },
    media: [],
    sizeBytes: 0,
    ...over,
  };
}

export function mockNetwork({ fail = false, size = 40_000 }: { fail?: boolean; size?: number } = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : (input as Request).url);
      calls.push(url);
      if (fail) throw new TypeError('Failed to fetch');
      // Uwaga: jsdom zamienia Blob w ciele Response na string „[object Blob]” (13 B),
      // więc do odpowiedzi wrzucamy Uint8Array — inaczej testy liczyłyby bajty z sufitu.
      return new Response(new Uint8Array(size), { status: 200, headers: { 'content-type': 'image/png' } });
    }),
  );
  return calls;
}
