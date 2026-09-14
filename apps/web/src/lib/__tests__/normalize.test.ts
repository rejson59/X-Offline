import { describe, expect, it } from 'vitest';
import {
  extractTweetList,
  normalizeTweet,
  normalizeTweets,
  parseNextData,
  syndicationToken,
  tweetIdFromUrl,
} from '../normalize';

const tweetResult = {
  __typename: 'Tweet',
  id_str: '1833333333333333333',
  text: 'Świetny dzień na offline-first #PWA https://t.co/abcd',
  created_at: '2026-09-01T09:12:00.000Z',
  lang: 'pl',
  favorite_count: 4210,
  conversation_count: 190,
  user: {
    id_str: '9',
    name: 'Orbita',
    screen_name: 'orbita_pl',
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/9/avatar_normal.jpg',
  },
  mediaDetails: [
    {
      media_url_https: 'https://pbs.twimg.com/media/ABC.jpg',
      type: 'photo',
      sizes: { large: { w: 1600, h: 900 } },
      extendedAltText: 'niebo nad Zabrzem',
    },
    {
      media_url_https: 'https://pbs.twimg.com/media/DEF.jpg',
      type: 'video',
      video_info: {
        variants: [
          { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/low.mp4' },
          { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/mid.mp4' },
          { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/hd.mp4' },
        ],
      },
      duration_millis: 14000,
    },
  ],
};

describe('syndicationToken', () => {
  it('jest stabilny i bez zer/kropek', () => {
    const t = syndicationToken('20');
    expect(t).toMatch(/^[0-9a-z]+$/);
    expect(syndicationToken('20')).toBe(t);
    expect(syndicationToken('')).toBe('1');
  });
});

describe('tweetIdFromUrl', () => {
  it('wyciąga id z linków x.com / twitter.com', () => {
    expect(tweetIdFromUrl('https://x.com/jack/status/20')).toBe('20');
    expect(tweetIdFromUrl('https://twitter.com/nasa/status/1585841080431321088?s=20')).toBe('1585841080431321088');
    expect(tweetIdFromUrl('https://x.com/i/web/status/1234567890123456789')).toBe('1234567890123456789');
    expect(tweetIdFromUrl('https://example.com/nope')).toBeNull();
    expect(tweetIdFromUrl('1833333333333333333')).toBe('1833333333333333333');
  });
});

describe('normalizeTweet', () => {
  it('normalizuje tweet-result wraz z mediami', () => {
    const post = normalizeTweet(tweetResult, 'syndication');
    expect(post).not.toBeNull();
    expect(post?.id).toBe('syndication:1833333333333333333');
    expect(post?.authorHandle).toBe('orbita_pl');
    expect(post?.createdAt).toBe(Date.parse('2026-09-01T09:12:00.000Z'));
    expect(post?.stats.likes).toBe(4210);
    expect(post?.media.map((m) => m.kind)).toEqual(['image', 'video']);
    expect(post?.media[0].url).toContain('pbs.twimg.com/media/ABC.jpg');
    expect(post?.media[0].alt).toBe('niebo nad Zabrzem');
    // Wideo: nie bierzemy najwyższego bitrate (offline ma ważyć mało).
    expect(post?.media[1].url).toBe('https://video.twimg.com/mid.mp4');
    expect(post?.tags).toEqual(expect.arrayContaining(['#pwa']));
    expect(post?.savedAt).toBeNull();
  });

  it('odrzuca wpisy bez treści i bez mediów', () => {
    expect(normalizeTweet({ id_str: '1', text: '' }, 'syndication')).toBeNull();
    expect(normalizeTweet({}, 'syndication')).toBeNull();
  });

  it('radzi sobie z shapeem legacy (full_text + extended_entities)', () => {
    const post = normalizeTweet(
      {
        id_str: '99',
        full_text: undefined,
        text: 'Legacy tweet',
        created_at: 'Tue Sep 01 09:00:00 +0000 2026',
        user: { screen_name: 'low_bitrate', name: 'Low Bitrate' },
        extended_entities: {
          media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/L.jpg' }],
        },
        favorite_count: '12',
      },
      'syndication',
    );
    expect(post?.text).toBe('Legacy tweet');
    expect(post?.stats.likes).toBe(12);
    expect(post?.media[0].url).toContain('L.jpg');
    expect(Number.isFinite(post!.createdAt)).toBe(true);
  });

  it('usuwa śmieci pic.twitter.com i dokleja nagłówek artykułu', () => {
    const post = normalizeTweet(
      { id_str: '5', text: 'Patrz https://t.co/xx https://pic.twitter.com/yy', user: { screen_name: 'a' } },
      'syndication',
    );
    expect(post?.text).toBe('Patrz https://t.co/xx');
    const article = normalizeTweet(
      { id_str: '6', text: 'lead', article: { title: 'Długi tekst' }, user: { screen_name: 'a' } },
      'syndication',
    );
    expect(article?.text).toContain('Długi tekst');
  });
});

describe('extractTweetList / normalizeTweets', () => {
  it('ogarnia entries z timeline-widgetu', () => {
    const payload = {
      timeline: [
        { content: { tweet: { ...tweetResult, id_str: '1' } } },
        { content: { tweet: { ...tweetResult, id_str: '2', created_at: '2026-09-02T09:12:00.000Z' } } },
      ],
    };
    const posts = normalizeTweets(payload, 'syndication', { handle: 'orbita_pl', count: 10 });
    expect(posts.map((p) => p.nativeId)).toEqual(['2', '1']);
  });

  it('pomija odpowiedzi, retweety i duplikaty', () => {
    const payload = {
      entries: [
        { content: { tweet: { ...tweetResult, id_str: '1' } } },
        { content: { tweet: { ...tweetResult, id_str: '1' } } },
        { content: { tweet: { ...tweetResult, id_str: '2', in_reply_to_status_id_str: '1' } } },
        { content: { tweet: { ...tweetResult, id_str: '3', retweeted_status_result: { user: { name: 'ktoś' } } } } },
      ],
    };
    const posts = normalizeTweets(payload, 'syndication', { handle: 'orbita_pl', dropReplies: true });
    expect(posts.map((p) => p.nativeId)).toEqual(['1']);
  });

  it('filtruje po uchwycie, którego żądaliśmy', () => {
    const posts = normalizeTweets({ entries: [{ content: { tweet: tweetResult } }] }, 'syndication', {
      handle: 'ktoś_inny',
    });
    expect(posts).toEqual([]);
  });

  it('parsuje __NEXT_DATA__ ze strony osadzonego timeline', () => {
    const html = `<!doctype html><html><body>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { timeline: { entries: [{ content: { tweet: tweetResult } }] } } },
      })}</script></body></html>`;
    const next = parseNextData(html);
    expect(next).toBeTruthy();
    const posts = normalizeTweets(next, 'syndication', { handle: 'orbita_pl' });
    expect(posts).toHaveLength(1);
    expect(extractTweetList(next).length).toBe(1);
  });

  it('zwraca pustą listę dla śmieci', () => {
    expect(parseNextData('<html>brak</html>')).toBeNull();
    expect(extractTweetList(null)).toEqual([]);
    expect(normalizeTweets('nie-json', 'syndication')).toEqual([]);
  });
});
