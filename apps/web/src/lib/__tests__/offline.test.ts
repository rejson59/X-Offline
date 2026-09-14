import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { ensureDemoSeeded } from '@/lib/demo';
import { cachePostMedia, blobKey, pruneToCap } from '@/lib/media';
import { exportLibrary, importLibrary, saveOffline, unsavePosts, upsertPosts } from '@/lib/posts';
import { useSettings } from '@/lib/store';
import type { PostRecord } from '@/lib/types';

function mockNetwork({ fail = false, size = 40_000 }: { fail?: boolean; size?: number } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(typeof input === 'string' ? input : (input as Request).url);
      calls.push(url);
      if (fail) throw new TypeError('Failed to fetch');
      const blob = new Blob([new Uint8Array(size)], { type: 'image/png' });
      return new Response(blob, { status: 200, headers: { 'content-type': 'image/png' } });
    }),
  );
  return calls;
}

async function freshDemo(): Promise<PostRecord[]> {
  await db.blobs.clear();
  await db.posts.clear();
  await db.accounts.clear();
  await db.jobs.clear();
  await ensureDemoSeeded(true);
  return db.posts.orderBy('createdAt').reverse().toArray();
}

beforeEach(() => {
  useSettings.setState({ settings: { ...useSettings.getState().settings, storageCapMb: 0, downloadVideo: true, respectSaveData: true } });
  mockNetwork();
});

describe('seed demo', () => {
  it('wstawia posty i konta', async () => {
    const posts = await freshDemo();
    expect(posts.length).toBeGreaterThan(20);
    expect(await db.accounts.count()).toBeGreaterThan(3);
    expect(posts.every((p) => p.source === 'demo')).toBe(true);
    expect(posts.every((p) => !p.savedAt)).toBe(true);
  });

  it('nie dubluje przy drugim uruchomieniu', async () => {
    const posts = await freshDemo();
    const again = await ensureDemoSeeded();
    expect(again).toBe(0);
    expect(await db.posts.count()).toBe(posts.length);
  });
});

describe('zapis do offline', () => {
  it('ciągnie media do IndexedDB i liczy bajty', async () => {
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length >= 1)!;
    expect(post).toBeTruthy();

    const outcome = await saveOffline(post);
    expect(outcome.ok).toBe(true);
    expect(outcome.cached).toBeGreaterThan(0);
    expect(outcome.bytes).toBeGreaterThan(0);

    const saved = await db.posts.get(post.id);
    expect(saved?.savedAt).toBeGreaterThan(0);
    expect(saved?.media.every((m) => m.cached)).toBe(true);
    expect(saved?.sizeBytes).toBe(outcome.bytes);
    expect(await db.blobs.count()).toBeGreaterThanOrEqual(outcome.cached);

    // Blob faktycznie leży w bazie i da się go odczytać bez sieci.
    const row = await db.blobs.get(blobKey(post.media[0].url));
    expect(row?.blob.size).toBeGreaterThan(0);
    expect(row?.mime).toBe('image/png');
  });

  it('zapisuje treść, nawet gdy media się nie pobiorą', async () => {
    mockNetwork({ fail: true });
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length >= 1)!;
    const outcome = await saveOffline(post);
    expect(outcome.cached).toBe(0);
    expect(outcome.errors.length).toBeGreaterThan(0);
    const saved = await db.posts.get(post.id);
    expect(saved?.savedAt).toBeGreaterThan(0);
    expect(saved?.text).toBe(post.text);
    expect(saved?.media.every((m) => !m.cached)).toBe(true);
  });

  it('usunięcie zwalnia miejsce', async () => {
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length >= 1)!;
    await saveOffline(post);
    expect(await db.blobs.count()).toBeGreaterThan(0);
    const freed = await unsavePosts([post.id]);
    expect(freed).toBeGreaterThan(0);
    expect(await db.blobs.count()).toBe(0);
    const after = await db.posts.get(post.id);
    expect(after?.savedAt).toBeNull();
    expect(after?.sizeBytes).toBe(0);
  });

  it('drugie zapisanie nie pobiera mediów ponownie', async () => {
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length >= 1)!;
    await saveOffline(post);
    const calls = mockNetwork();
    const second = await saveOffline(post);
    expect(second.bytes).toBeGreaterThan(0);
    expect(calls.filter((u) => u.includes('demo-media'))).toHaveLength(0);
  });

  it('ponowne pobranie profilu nie gubi flagi „cached”', async () => {
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length >= 1)!;
    await saveOffline(post);
    await upsertPosts([{ ...post, text: 'aktualizacja z sieci', savedAt: null, sizeBytes: 0 }]);
    const merged = await db.posts.get(post.id);
    expect(merged?.text).toBe('aktualizacja z sieci');
    expect(merged?.savedAt).toBeGreaterThan(0);
    expect(merged?.media.some((m) => m.cached)).toBe(true);
  });
});

describe('limit miejsca', () => {
  it('przycina najstarsze poza limitem', async () => {
    const posts = await freshDemo();
    const withMedia = posts.filter((p) => p.media.length).slice(0, 4);
    for (const p of withMedia) await saveOffline(p);
    expect(await db.posts.where('savedAt').above(0).count()).toBe(withMedia.length);

    const res = await pruneToCap(1, 1); // ~1 MB, zostawiamy 1 najnowszy
    expect(res.removed).toBe(withMedia.length - 1);
    expect(await db.posts.where('savedAt').above(0).count()).toBe(1);
  });

  it('bez limitu nie tnie nic', async () => {
    const posts = await freshDemo();
    await saveOffline(posts.find((p) => p.media.length)!);
    expect(await pruneToCap(0, 0)).toEqual({ removed: 0, bytes: 0 });
  });
});

describe('cache mediów', () => {
  it('pomija wideo, gdy użytkownik nie chce ich pobierać', async () => {
    useSettings.setState({
      settings: { ...useSettings.getState().settings, downloadVideo: false },
    });
    await freshDemo();
    const post: PostRecord = {
      id: 'demo:video-test',
      nativeId: 'video-test',
      source: 'demo',
      authorHandle: 'x',
      authorName: 'X',
      text: 'klip',
      createdAt: Date.now(),
      stats: { replies: 0, reposts: 0, likes: 0 },
      sizeBytes: 0,
      savedAt: null,
      media: [
        { kind: 'video', url: 'https://video.twimg.com/a.mp4' },
        { kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg' },
      ],
    };
    await db.posts.put(post);
    const out = await cachePostMedia(post);
    expect(out.cached).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it('przy braku łącza nie próbuje niczego ściągnąć', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    useSettings.getState().refreshNet();
    const posts = await freshDemo();
    const post = posts.find((p) => p.media.length)!;
    const out = await cachePostMedia(post);
    expect(out.cached).toBe(0);
    expect(out.errors[0]).toContain('oszczędzanie danych');
  });
});

describe('eksport / import biblioteki', () => {
  it('round-trip przez plik JSON', async () => {
    const posts = await freshDemo();
    const targets = posts.filter((p) => p.media.length).slice(0, 2);
    for (const p of targets) await saveOffline(p);

    const lib = await exportLibrary();
    expect(lib.app).toBe('x-offline');
    expect(lib.posts).toHaveLength(2);

    await db.blobs.clear();
    await db.posts.clear();
    const res = await importLibrary(lib);
    expect(res.posts).toBe(2);
    const reread = await db.posts.where('savedAt').above(0).toArray();
    expect(reread).toHaveLength(2);
    expect(reread.every((p) => p.fetchedFrom === 'library')).toBe(true);
  });

  it('odrzuca obcy plik', async () => {
    await expect(importLibrary({ hello: 'world' })).rejects.toThrow(/x-offline/i);
  });
});
