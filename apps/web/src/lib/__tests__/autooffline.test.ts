import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { captureEvents, followHandles, ingestPosts, ingestTweets, savedOfflineCount } from '@/lib/capture';
import { hasPendingFor, maybeReplay, reportResults, retryErrors, toggleBookmark, toggleLike } from '@/lib/actions';
import { useSettings } from '@/lib/store';
import { useFill } from '@/lib/autosync';
import { makePost, mockNetwork } from './helpers';
import type { NormalizedPost } from '@/lib/normalize';
import type { PostRecord } from '@/lib/types';

function stubPosts(n: number, over: Partial<PostRecord> = {}): NormalizedPost[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `syndication:${9000 + i}`,
    nativeId: String(9000 + i),
    source: 'syndication' as const,
    authorHandle: 'orbita_pl',
    authorName: 'Orbita',
    text: `Post testowy ${i} #offline`,
    createdAt: Date.now() - i * 60_000,
    savedAt: null,
    stats: { replies: i, reposts: 0, likes: i * 3 },
    media: [],
    sizeBytes: 0,
    tags: ['#offline'],
    ...over,
  }));
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  mockNetwork();
  await db.blobs.clear();
  await db.posts.clear();
  await db.accounts.clear();
  await db.actions.clear();
  await db.jobs.clear();
  useSettings.setState({
    online: true,
    settings: {
      ...useSettings.getState().settings,
      sourceMode: 'auto',
      autoCapture: true,
      autoTarget: 5,
      storageCapMb: 0,
      mirrorToBookmarks: false,
      mirrorBookmarks: true,
      replayActions: true,
      mediaOnWifiOnly: false,
      trimOverTarget: false,
      persistStorage: false,
      followList: 'orbita_pl, nasa',
    },
  });
});

describe('polityka auto-zapisu', () => {
  it('zapisuje do celu i zatrzymuje się na nim', async () => {
    const report = await ingestPosts(stubPosts(9), { via: 'auto-scroll', source: 'live-scroll' });
    expect(report.seen).toBe(9);
    expect(report.saved).toBe(5);
    expect(report.reason).toContain('limit 5');
    expect(await savedOfflineCount()).toBe(5);
  });

  it('nie zapisuje nic, gdy auto-zapis jest wyłączony', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, autoCapture: false } });
    const report = await ingestPosts(stubPosts(4), { via: 'auto-scroll', source: 'live-scroll' });
    expect(report.saved).toBe(0);
    expect(await savedOfflineCount()).toBe(0);
  });

  it('zakładka X omija limit celu (ale tylko przy włączonej lustrzance)', async () => {
    await ingestPosts(stubPosts(5), { via: 'auto-scroll', source: 'live-scroll' });
    const marked = stubPosts(1, { id: 'syndication:12345', nativeId: '12345' });
    marked[0].xBookmarked = true;
    const report = await ingestPosts(marked, { via: 'auto-scroll', source: 'live-scroll' });
    expect(report.saved).toBe(1);
    expect(await savedOfflineCount()).toBe(6);

    // …a gdy lustrzanka jest wyłączona, zakładka nie rozpycha biblioteki poza cel
    useSettings.setState({ settings: { ...useSettings.getState().settings, mirrorBookmarks: false } });
    const other = stubPosts(1, { id: 'syndication:999', nativeId: '999' });
    other[0].xBookmarked = true;
    const second = await ingestPosts(other, { via: 'auto-scroll', source: 'live-scroll' });
    expect(second.saved).toBe(0);
  });

  it('posty już zapisane nie liczą się drugi raz do celu', async () => {
    await ingestPosts(stubPosts(3), { via: 'auto-scroll', source: 'live-scroll' });
    const again = await ingestPosts(stubPosts(3), { via: 'auto-scroll', source: 'live-scroll' });
    expect(again.saved).toBe(0);
    expect(again.skipped).toBe(3);
    expect(await savedOfflineCount()).toBe(3);
  });

  it('import z pliku nie przejmuje się limitem', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, autoTarget: 1 } });
    const report = await ingestPosts(stubPosts(4), { via: 'import', source: 'import', force: true });
    expect(report.saved).toBe(4);
  });

  it('przy lustrzance w drugą stronę dokleja akcję „bookmark”', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, autoTarget: 10, mirrorToBookmarks: true } });
    await ingestPosts(stubPosts(2), { via: 'auto-scroll', source: 'live-scroll' });
    const rows = await db.actions.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'bookmark' && r.status === 'pending' && r.origin === 'mirror')).toBe(true);
  });

  it('twarde przycięcie do celu odznacza najstarsze', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, autoTarget: 3, trimOverTarget: true } });
    await ingestPosts(stubPosts(6), { via: 'auto-scroll', source: 'live-scroll' });
    expect(await savedOfflineCount()).toBe(3);
  });

  it('ingestTweets ogarnia surowy payload z GraphQL (legacy + favorited)', async () => {
    const raw = {
      source: 'live-scroll',
      tweets: [
        {
          rest_id: '1111222233334444555',
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
            id_str: '1111222233334444555',
            created_at: 'Tue Sep 01 09:12:00 +0000 2026',
            favorite_count: 12,
            favorited: true,
            bookmarked: true,
            full_text: 'prawdziwy post z podglądu X',
            extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/z.jpg' }] },
          },
        },
      ],
    };
    const report = await ingestTweets(raw, { via: 'auto-scroll', source: 'live-scroll', maxPosts: 10, origin: 'live' });
    expect(report.seen).toBe(1);
    expect(report.saved).toBe(1);
    const post = await db.posts.get('syndication:1111222233334444555');
    expect(post?.authorHandle).toBe('orbita_pl');
    expect(post?.xLiked).toBe(true);
    expect(post?.xBookmarked).toBe(true);
    expect(post?.media).toHaveLength(1);
    expect(post?.origin).toBe('live');
  });

  it('wpisuje realny profil na listę kont i zapisuje zdarzenie w dzienniku zbierania', async () => {
    await ingestPosts(stubPosts(2), { via: 'auto-scroll', source: 'live-scroll', origin: 'live' });
    const account = await db.accounts.get('orbita_pl');
    expect(account?.lastStatus).toBe('ok');
    expect(captureEvents().length).toBeGreaterThan(0);
  });

  it('lista profili czyta się z ustawień i ignoruje śmieci', () => {
    useSettings.setState({
      settings: { ...useSettings.getState().settings, followList: '@nasa, https://x.com/spacex/, zle-za-dlugie-nazwy!!, , ok_1' },
    });
    expect(followHandles()).toEqual(['nasa', 'spacex', 'ok_1']);
  });
});

describe('kolejka akcji (polub / zapisz teraz, wyślij później)', () => {
  async function onePost(): Promise<PostRecord> {
    const post = makePost();
    await db.posts.put(post);
    return post;
  }

  it('polubienie flipuje stan lokalnie i dokłada pending', async () => {
    const post = await onePost();
    expect(post.xLiked).toBeFalsy();
    const out = await toggleLike(post);
    expect(out.kind).toBe('like');
    const stored = await db.posts.get(post.id);
    expect(stored?.xLiked).toBe(true);
    const rows = (await db.actions.toArray()).filter((r) => r.postId === post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('like');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].tweetId).toBe(post.nativeId);
    expect(await hasPendingFor(post.id)).toBeTruthy();
  });

  it('cofnięcie polubienia daje akcję „unlike”', async () => {
    const post = await onePost();
    await db.posts.update(post.id, { xLiked: true });
    const out = await toggleLike({ ...post, xLiked: true });
    expect(out.kind).toBe('unlike');
  });

  it('zakładka z czytnika zapisuje też post do offline', async () => {
    const post = await onePost();
    expect(post.savedAt).toBeFalsy();
    await toggleBookmark(post);
    const stored = await db.posts.get(post.id);
    expect(stored?.savedAt).toBeGreaterThan(0);
    expect(stored?.xBookmarked).toBe(true);
  });

  it('bez natywnej sesji akcje grzecznie czekają', async () => {
    const post = await onePost();
    await toggleLike(post);
    const res = await maybeReplay();
    expect(res.sent).toBe(0);
    expect(res.deferred).toBe(true);
    expect(res.reason).toMatch(/natywnej|APK/);
    const row = (await db.actions.toArray())[0];
    expect(row.status).toBe('pending');
  });

  it('wysyłka wyłączona w ustawieniach → nic się nie dzieje', async () => {
    const post = await onePost();
    await toggleLike(post);
    useSettings.setState({ settings: { ...useSettings.getState().settings, replayActions: false } });
    const res = await maybeReplay();
    expect(res.deferred).toBe(true);
    expect(res.reason).toContain('wyłączone');
  });

  it('bez łącza nie próbujemy wysyłać', async () => {
    const post = await onePost();
    await toggleLike(post);
    useSettings.setState({ online: false });
    const res = await maybeReplay();
    expect(res.deferred).toBe(true);
    expect(res.reason).toContain('brak łącza');
  });

  it('reportResults zamyka akcje i czyści błąd posta', async () => {
    const post = await onePost();
    await toggleLike(post);
    const row = (await db.actions.toArray())[0];
    await db.actions.update(row.id as number, { status: 'error', error: 'sesja wygasła' });
    await db.posts.update(post.id, { actionError: 'sesja wygasła' });
    expect(await retryErrors()).toBe(1);
    const again = (await db.actions.toArray())[0];
    await reportResults([{ id: again.id as number, ok: true }]);
    const after = await db.actions.get(again.id as number);
    expect(after?.status).toBe('sent');
    expect(after?.sentAt).toBeGreaterThan(0);
  });
});

describe('edytor „dociągnij do celu” (tryb przeglądarkowy)', () => {
  it('loguje brak profili zamiast zaciągać cokolwiek z sufitu', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, followList: '', autoTarget: 10 } });
    await useFill.getState().start(10);
    expect(useFill.getState().running).toBe(false);
    expect(useFill.getState().error).toMatch(/Nie ma skąd czytać|profil/i);
    expect(await savedOfflineCount()).toBe(0);
  });

  it('zatrzymuje się, gdy profili nie da się pobrać (brak proxy)', async () => {
    mockNetwork({ fail: true });
    useSettings.setState({ settings: { ...useSettings.getState().settings, followList: 'orbita_pl', autoTarget: 12 } });
    await useFill.getState().start(12);
    expect(useFill.getState().running).toBe(false);
    expect(await savedOfflineCount()).toBe(0);
    expect(useFill.getState().log.some((l) => l.kind === 'warn' || l.kind === 'error')).toBe(true);
  }, 20000);

  it('nie startuje drugi raz w trakcie pracy', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, followList: 'orbita_pl', autoTarget: 10 } });
    const first = useFill.getState().start(10);
    const second = useFill.getState().start(10);
    await Promise.all([first, second]);
    expect(useFill.getState().running).toBe(false);
  }, 20000);
});
