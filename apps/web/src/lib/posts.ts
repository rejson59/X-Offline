import { db } from '@/db/db';
import { cachePostMedia, dropMediaFor } from './media';
import type { PostRecord } from './types';

/** Wstawia/aktualizuje posty, zachowując to, co już zostało pobrane do offline. */
export async function upsertPosts(posts: PostRecord[]): Promise<PostRecord[]> {
  const merged: PostRecord[] = [];
  // Jeśli dla posta czeka akcja (polubienie/zakładka kliknięte offline), NIE nadpisujemy
  // tych flag tym, co mówi serwer — inaczej świeżo pobrany post „anulowałby” nasz zamiar.
  const queued = await db.actions.where('status').anyOf('pending', 'sending').toArray();
  const queuedIds = new Set(queued.map((a) => a.tweetId));
  await db.transaction('rw', db.posts, async () => {
    for (const post of posts) {
      const existing = await db.posts.get(post.id);
      const keepInteractions = existing && queuedIds.has(existing.nativeId);
      const next: PostRecord = {
        ...post,
        savedAt: existing?.savedAt ?? post.savedAt ?? null,
        sizeBytes: existing?.sizeBytes ?? post.sizeBytes ?? 0,
        xLiked: keepInteractions ? existing.xLiked : (post.xLiked ?? existing?.xLiked ?? false),
        xBookmarked: keepInteractions ? existing.xBookmarked : (post.xBookmarked ?? existing?.xBookmarked ?? false),
        media: post.media.map((m) => {
          const prev = existing?.media?.find((x) => x.url === m.url);
          return prev?.cached ? { ...m, cached: true, bytes: prev.bytes } : m;
        }),
      };
      await db.posts.put(next);
      merged.push(next);
    }
  });
  return merged;
}

export interface SaveOutcome {
  ok: boolean;
  bytes: number;
  cached: number;
  skipped: number;
  errors: string[];
}

/** Zapis posta + mediów do offline. */
export async function saveOffline(post: PostRecord, signal?: AbortSignal): Promise<SaveOutcome> {
  // Nie zadeptujemy stanu, który zdążył się zmienić (np. właśnie dodaliśmy zakładkę).
  const existing = await db.posts.get(post.id);
  await db.posts.put(
    existing
      ? {
          ...post,
          xLiked: post.xLiked ?? existing.xLiked,
          xBookmarked: post.xBookmarked ?? existing.xBookmarked,
          savedAt: existing.savedAt ?? post.savedAt ?? null,
        }
      : post,
  );
  const outcome = await cachePostMedia(post, signal);
  await db.posts.update(post.id, { savedAt: Date.now() });
  await refreshAccountCounts();
  return {
    ok: !outcome.errors.length || outcome.cached > 0,
    bytes: outcome.bytes,
    cached: outcome.cached,
    skipped: outcome.skipped,
    errors: outcome.errors,
  };
}

export async function unsavePosts(ids: string[]): Promise<number> {
  const freed = await dropMediaFor(ids);
  await db.transaction('rw', db.posts, async () => {
    for (const id of ids) {
      const post = await db.posts.get(id);
      if (!post) continue;
      await db.posts.update(id, {
        savedAt: null,
        sizeBytes: 0,
        media: post.media.map((m) => ({ ...m, cached: false, bytes: undefined })),
      });
    }
  });
  await refreshAccountCounts();
  return freed;
}

export async function deletePosts(ids: string[]): Promise<void> {
  await dropMediaFor(ids);
  await db.posts.bulkDelete(ids);
}

export async function refreshAccountCounts(): Promise<void> {
  const rows = await db.posts.toArray();
  const byHandle = new Map<string, number>();
  for (const p of rows) if (p.savedAt) byHandle.set(p.authorHandle, (byHandle.get(p.authorHandle) ?? 0) + 1);
  const accounts = await db.accounts.toArray();
  for (const acc of accounts) {
    const saved = byHandle.get(acc.handle) ?? 0;
    if (saved !== acc.savedCount) await db.accounts.update(acc.handle, { savedCount: saved });
  }
}

export function savedPostsQuery() {
  return db.posts.where('savedAt').above(0);
}

export interface LibraryExport {
  app: 'x-offline';
  version: 1;
  exportedAt: string;
  posts: PostRecord[];
  accounts: { handle: string; name?: string }[];
}

export async function exportLibrary(): Promise<LibraryExport> {
  const posts = await db.posts.where('savedAt').above(0).toArray();
  const accounts = await db.accounts.toArray();
  return {
    app: 'x-offline',
    version: 1,
    exportedAt: new Date().toISOString(),
    posts,
    accounts: accounts.map((a) => ({ handle: a.handle, name: a.name })),
  };
}

export async function importLibrary(payload: unknown): Promise<{ posts: number; bytes: number }> {
  const lib = payload as LibraryExport;
  if (!lib || lib.app !== 'x-offline' || !Array.isArray(lib.posts)) {
    throw new Error('To nie jest plik biblioteki X-Offline (oczekiwano pola „app”: „x-offline”).');
  }
  let bytes = 0;
  for (const post of lib.posts) {
    if (!post?.id || typeof post.text !== 'string') continue;
    await db.posts.put({ ...post, savedAt: post.savedAt ?? Date.now(), fetchedFrom: 'library' });
    // Media przy imporcie z pliku nie jadą w JSON-ie — dociągamy je, jeśli jest łącze.
    if (post.media?.some((m) => !m.cached)) {
      const out = await cachePostMedia(post);
      bytes += out.bytes;
    } else {
      bytes += post.sizeBytes ?? 0;
    }
  }
  await refreshAccountCounts();
  return { posts: lib.posts.length, bytes };
}
