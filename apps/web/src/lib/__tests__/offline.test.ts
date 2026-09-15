import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { blobKey, cachePostMedia, mediaBytes, pruneToCap, trimSavedToTarget } from '@/lib/media';
import {
  countUnread,
  deletePosts,
  exportLibrary,
  exportMarkdown,
  fetchMissingMedia,
  importLibrary,
  markRead,
  saveOffline,
  unsavePosts,
  upsertPosts,
} from '@/lib/posts';
import { useSettings } from '@/lib/store';
import { makePost, mockNetwork } from './helpers';
import type { PostRecord } from '@/lib/types';

beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.blobs.clear();
  await db.posts.clear();
  await db.accounts.clear();
  await db.actions.clear();
  await db.jobs.clear();
  useSettings.setState({
    settings: { ...useSettings.getState().settings, storageCapMb: 0, downloadVideo: true, respectSaveData: true, persistStorage: false },
  });
  mockNetwork();
});

function withMedia(over: Partial<PostRecord> = {}): PostRecord {
  return makePost({
    media: [
      { kind: 'image', url: `https://pbs.twimg.com/media/${Math.random().toString(36).slice(2)}.jpg` },
    ],
    ...over,
  });
}

describe('zapis do offline', () => {
  it('ciągnie media do IndexedDB i liczy bajty', async () => {
    const post = withMedia();
    await db.posts.put(post);
    const outcome = await saveOffline(post);
    expect(outcome.ok).toBe(true);
    expect(outcome.cached).toBe(1);
    expect(outcome.bytes).toBeGreaterThan(0);

    const saved = await db.posts.get(post.id);
    expect(saved?.savedAt).toBeGreaterThan(0);
    expect(saved?.media.every((m) => m.cached)).toBe(true);
    expect(saved?.sizeBytes).toBe(outcome.bytes);
    expect(outcome.pendingMedia).toBe(0);

    const row = await db.blobs.get(blobKey(post.media[0].url));
    expect(row?.blob.size).toBeGreaterThan(0);
    expect(row?.mime).toBe('image/png');
  });

  it('zapisuje treść, nawet gdy media się nie pobiorą (i mówi, ile brakuje)', async () => {
    mockNetwork({ fail: true });
    const post = withMedia();
    await db.posts.put(post);
    const outcome = await saveOffline(post);
    expect(outcome.cached).toBe(0);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.pendingMedia).toBe(1);
    const saved = await db.posts.get(post.id);
    expect(saved?.savedAt).toBeGreaterThan(0);
    expect(saved?.text).toBe(post.text);
    expect(saved?.mediaError).toMatch(/failed to fetch/i);
  });

  it('nie gubi zapisu, gdy post ma tylko tekst (bez sieci)', async () => {
    const post = makePost();
    await db.posts.put(post);
    const out = await saveOffline(post, undefined);
    expect(out.ok).toBe(true);
    expect((await db.posts.get(post.id))?.savedAt).toBeGreaterThan(0);
  });

  it('usunięcie z offline zwalnia miejsce, ale zostawia treść', async () => {
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    expect(await db.blobs.count()).toBeGreaterThan(0);
    const freed = await unsavePosts([post.id]);
    expect(freed).toBeGreaterThan(0);
    expect(await db.blobs.count()).toBe(0);
    const after = await db.posts.get(post.id);
    expect(after?.savedAt).toBeNull();
    expect(after?.sizeBytes).toBe(0);
    expect(after?.text).toBe(post.text);
  });

  it('drugie zapisanie nie pobiera mediów ponownie', async () => {
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    const calls = mockNetwork();
    const second = await saveOffline(post);
    expect(second.bytes).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('ponowne pobranie posta nie gubi flagi „cached” ani zapisu', async () => {
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    await upsertPosts([{ ...post, text: 'aktualizacja z sieci', savedAt: null, sizeBytes: 0 }]);
    const merged = await db.posts.get(post.id);
    expect(merged?.text).toBe('aktualizacja z sieci');
    expect(merged?.savedAt).toBeGreaterThan(0);
    expect(merged?.media.some((m) => m.cached)).toBe(true);
  });

  it('czekająca akcja chroni polubienie przed nadpisaniem z sieci', async () => {
    const post = makePost();
    await db.posts.put(post);
    await saveOffline(post);
    await db.posts.update(post.id, { xLiked: true });
    await db.actions.add({ kind: 'like', tweetId: post.nativeId, postId: post.id, status: 'pending', attempts: 0, createdAt: Date.now() });
    // Serwer jeszcze nie wie o polubieniu — ale nasza kolejka tak, więc nie cofamy stanu.
    await upsertPosts([{ ...post, xLiked: false, text: 'świeżo z sieci' }]);
    const merged = await db.posts.get(post.id);
    expect(merged?.text).toBe('świeżo z sieci');
    expect(merged?.xLiked).toBe(true);
  });

  it('dociąga brakujące media po fakcie', async () => {
    mockNetwork({ fail: true });
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    expect((await db.posts.get(post.id))?.media.every((m) => !m.cached)).toBe(true);

    mockNetwork();
    const out = await fetchMissingMedia([post.id]);
    expect(out.posts).toBe(1);
    expect(out.bytes).toBeGreaterThan(0);
    expect((await db.posts.get(post.id))?.media.every((m) => m.cached)).toBe(true);
  });
});

describe('stan przeczytania', () => {
  it('liczy nieprzeczytane i potrafi je odznaczyć', async () => {
    const a = withMedia();
    const b = withMedia();
    await db.posts.bulkPut([a, b]);
    await saveOffline(a);
    await saveOffline(b);
    expect(await countUnread()).toBe(2);
    await markRead([a.id]);
    expect(await countUnread()).toBe(1);
    await markRead([a.id], false);
    expect(await countUnread()).toBe(2);
  });

  it('kasowanie trwałe zabiera też media', async () => {
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    await deletePosts([post.id]);
    expect(await db.posts.get(post.id)).toBeUndefined();
    expect(await db.blobs.count()).toBe(0);
  });
});

describe('limit miejsca', () => {
  it('zrzuca media najstarszych, ale NIE kasuje postów', async () => {
    const posts = [withMedia(), withMedia(), withMedia(), withMedia()];
    await db.posts.bulkPut(posts);
    for (const [i, p] of posts.entries()) {
      await saveOffline(p);
      await db.posts.update(p.id, { savedAt: Date.now() - (posts.length - i) * 60_000 });
    }
    expect(await db.posts.where('savedAt').above(0).count()).toBe(4);

    const res = await pruneToCap(1, 1); // ~1 MB, zostawiamy 1 najnowszy w spokoju
    expect(res.removed).toBe(3);
    expect(res.bytes).toBe(3 * 40_000);
    // Teksty zostają w bibliotece — to była cała idea.
    expect(await db.posts.where('savedAt').above(0).count()).toBe(4);
    // Media najnowszego (idx 0) zostają, starszych zniknęły.
    expect(await mediaBytes()).toBe(40_000);
    const oldest = await db.posts.get(posts[0].id);
    expect(oldest?.media.every((m) => !m.cached)).toBe(true);
    expect(oldest?.mediaError).toContain('auto-czyszczenie');
  });

  it('bez limitu nie tnie nic', async () => {
    const post = withMedia();
    await db.posts.put(post);
    await saveOffline(post);
    expect(await pruneToCap(0, 0)).toEqual({ removed: 0, bytes: 0, kept: 0 });
  });

  it('twarde przycięcie do celu odznacza najstarsze', async () => {
    const posts = [withMedia(), withMedia(), withMedia()];
    await db.posts.bulkPut(posts);
    for (const [i, p] of posts.entries()) {
      await saveOffline(p);
      await db.posts.update(p.id, { savedAt: Date.now() - (posts.length - i) * 60_000 });
    }
    const removed = await trimSavedToTarget(1);
    expect(removed).toBe(2);
    expect(await db.posts.where('savedAt').above(0).count()).toBe(1);
  });
});

describe('cache mediów', () => {
  it('pomija wideo, gdy użytkownik nie chce ich pobierać', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, downloadVideo: false } });
    const post = makePost({
      media: [
        { kind: 'video', url: 'https://video.twimg.com/a.mp4' },
        { kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg' },
      ],
    });
    await db.posts.put(post);
    const out = await cachePostMedia(post);
    expect(out.cached).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it('przy braku łącza nie próbuje niczego ściągnąć', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    useSettings.getState().refreshNet();
    const post = withMedia();
    await db.posts.put(post);
    const out = await cachePostMedia(post);
    expect(out.cached).toBe(0);
    expect(out.errors[0]).toContain('oszczędzanie danych');
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    useSettings.getState().refreshNet();
  });
});

describe('eksport / import biblioteki', () => {
  it('round-trip przez plik JSON', async () => {
    const posts = [withMedia(), withMedia()];
    await db.posts.bulkPut(posts);
    for (const p of posts) await saveOffline(p);

    const lib = await exportLibrary();
    expect(lib.app).toBe('x-offline');
    expect(lib.version).toBe(2);
    expect(lib.posts).toHaveLength(2);

    await db.blobs.clear();
    await db.posts.clear();
    const res = await importLibrary(lib);
    expect(res.posts).toBe(2);
    const reread = await db.posts.where('savedAt').above(0).toArray();
    expect(reread).toHaveLength(2);
    expect(reread.every((p) => p.fetchedFrom === 'library')).toBe(true);
  });

  it('eksport Markdown ma treść i nagłówki', async () => {
    const post = withMedia({ text: 'Bardzo ważny post o offline.' });
    await db.posts.put(post);
    await saveOffline(post);
    const md = await exportMarkdown();
    expect(md.posts).toBe(1);
    expect(md.name).toMatch(/\.md$/);
    expect(md.text).toContain('Bardzo ważny post o offline.');
    expect(md.text).toContain('@orbita_pl');
  });

  it('odrzuca obcy plik', async () => {
    await expect(importLibrary({ hello: 'world' })).rejects.toThrow(/x-offline/i);
  });
});

describe('zapis, gdy w telefonie kończy się miejsce', () => {
  it('po QuotaExceededError zwalnia media i dopisuje post', async () => {
    // Post z mediami w bibliotece — to one polecą jako pierwsze, gdy zabraknie miejsca.
    const old = withMedia({ text: 'stary post z grafiką' });
    await db.posts.put(old);
    await saveOffline(old);
    expect(await mediaBytes()).toBeGreaterThan(0);

    const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    const put = vi.spyOn(db.posts, 'put');
    put.mockRejectedValueOnce(quota);

    const fresh = makePost({ text: 'świeży post, dla którego brakowało miejsca' });
    const out = await saveOffline(fresh);
    expect(out.ok).toBe(true);
    expect((await db.posts.get(fresh.id))?.savedAt).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await db.posts.get(old.id)).toBeTruthy(), { timeout: 5000 });
    // Media starego posta zniknęły, ale sam post (i tekst) został — czytasz dalej.
    expect(await mediaBytes()).toBe(0);
    expect((await db.posts.get(old.id))?.media[0]?.cached).toBeFalsy();
    put.mockRestore();
  });

  it('gdy miejsce nadal się nie znajduje, mówi po ludzku co zrobić', async () => {
    const put = vi.spyOn(db.posts, 'put');
    put.mockRejectedValue(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }));
    await expect(saveOffline(makePost())).rejects.toThrow(/Brak miejsca/);
    put.mockRestore();
  });

  it('zwykły błąd bazy nie jest maskowany', async () => {
    const put = vi.spyOn(db.posts, 'put');
    put.mockRejectedValueOnce(new Error('IndexedDB: baza zablokowana'));
    await expect(saveOffline(makePost())).rejects.toThrow(/zablokowana/);
    put.mockRestore();
  });
});
