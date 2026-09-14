import { db } from '@/db/db';
import { fetchBlob } from './transport';
import { shouldSkipMedia, useSettings } from './store';
import type { MediaItem, PostRecord } from './types';

/** Klucz cache'u dla URL-a. */
export function blobKey(url: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < url.length; i++) {
    h1 = Math.imul(h1 ^ url.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + url.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}-${url.length}`;
}

const objectUrls = new Map<string, string>();

export function objectUrlFor(key: string, blob: Blob): string {
  const existing = objectUrls.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

export function revokeAllObjectUrls(): void {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
}

export interface CacheOutcome {
  bytes: number;
  cached: number;
  skipped: number;
  errors: string[];
}

/**
 * Pobiera i odkłada media posta w IndexedDB. Zwraca informację, co się udało —
 * tekst posta i tak zapisujemy, żeby „brak zasięgu” nie oznaczał „brak treści”.
 */
export async function cachePostMedia(post: PostRecord, signal?: AbortSignal): Promise<CacheOutcome> {
  const out: CacheOutcome = { bytes: 0, cached: 0, skipped: 0, errors: [] };
  const { settings } = useSettings.getState();

  if (shouldSkipMedia() && post.media.length) {
    return {
      bytes: 0,
      cached: 0,
      skipped: post.media.length,
      errors: ['pominięto media: system zgłasza oszczędzanie danych lub brak łącza'],
    };
  }

  const wanted = post.media.filter((m) => {
    if (m.kind === 'video' && !settings.downloadVideo) return false;
    return true;
  });
  const media = [...post.media];

  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (signal?.aborted) {
      out.errors.push('anulowano');
      break;
    }
    const wantedItem = wanted.some((w) => w.url === item.url);
    if (!wantedItem) {
      out.skipped++;
      continue;
    }
    // Ten sam plik może występować w kilku postach — nie ściągamy go drugi raz.
    const existing = await db.blobs.get(blobKey(item.url));
    if (existing) {
      media[i] = { ...item, cached: true, bytes: existing.bytes };
      out.cached++;
      out.bytes += existing.bytes;
      continue;
    }
    try {
      const { blob, bytes, mime } = await fetchBlob(item.url);
      const key = blobKey(item.url);
      await db.blobs.put({ key, postId: post.id, url: item.url, mime, bytes, createdAt: Date.now(), blob });
      if (item.poster && !item.poster.startsWith('blob:')) {
        try {
          const p = await fetchBlob(item.poster);
          await db.blobs.put({
            key: blobKey(item.poster),
            postId: post.id,
            url: item.poster,
            mime: p.mime || 'image/jpeg',
            bytes: p.bytes,
            createdAt: Date.now(),
            blob: p.blob,
          });
        } catch {
          /* plakat to miły dodatek */
        }
      }
      const next: MediaItem = { ...item, cached: true, bytes };
      media[i] = next;
      out.bytes += bytes;
      out.cached++;
    } catch (err) {
      out.skipped++;
      out.errors.push(`${shortUrl(item.url)}: ${(err as Error).message}`);
    }
  }

  const sizeBytes = media.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  await db.posts.update(post.id, { media, sizeBytes });
  return out;
}

export async function dropMediaFor(postIds: string[]): Promise<number> {
  const rows = await db.blobs.where('postId').anyOf(postIds).toArray();
  await db.blobs.bulkDelete(rows.map((r) => r.key));
  for (const row of rows) {
    const u = objectUrls.get(row.key);
    if (u) {
      URL.revokeObjectURL(u);
      objectUrls.delete(row.key);
    }
  }
  return rows.reduce((s, r) => s + r.bytes, 0);
}

/** Rozwiązuje URL media: najpierw lokalny blob, potem zdalny (service worker i tak ma CacheFirst). */
export async function resolveMediaUrl(item: MediaItem): Promise<{ src: string; local: boolean }> {
  if (item.url.startsWith('/') || item.url.startsWith('data:') || item.url.startsWith('blob:')) {
    return { src: item.url, local: true };
  }
  const row = await db.blobs.get(blobKey(item.url));
  if (row) return { src: objectUrlFor(row.key, row.blob), local: true };
  const posterRow = item.poster ? await db.blobs.get(blobKey(item.poster)) : undefined;
  if (item.kind === 'image' && posterRow) return { src: objectUrlFor(posterRow.key, posterRow.blob), local: true };
  return { src: proxiedRemote(item.url), local: false };
}

function proxiedRemote(url: string): string {
  const { settings, hydrated } = useSettings.getState();
  if (!hydrated) return url;
  // Zdjęcia z pbs.twimg.com działają w <img> bez proxy; proxy tylko gdy ustawiono własny serwer
  // i użytkownik chce je wymusić (np. żeby service worker nie musiał korzystać z CORS).
  const base = (settings.proxyUrl || '').trim();
  if (base && /twimg\.com/.test(url)) {
    return `${base.replace(/\/$/, '')}/api/media?url=${encodeURIComponent(url)}`;
  }
  return url;
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (!navigator.storage?.estimate) {
    const rows = await db.blobs.toArray();
    return { usage: rows.reduce((acc, b) => acc + b.bytes, 0), quota: 0 };
  }
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/** Trzyma cache w ryzach: usuwa media najstarszych, rzadziej czytanych postów. */
export async function pruneToCap(capMb: number, keepPosts: number): Promise<{ removed: number; bytes: number }> {
  if (!capMb) return { removed: 0, bytes: 0 };
  const savedRows = await db.posts.where('savedAt').above(0).toArray();
  const saved = savedRows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  let removed = 0;
  let bytes = 0;
  const cap = capMb * 1024 * 1024;
  const toDrop: string[] = [];

  for (const [idx, post] of saved.entries()) {
    if (idx < keepPosts) continue;
    toDrop.push(post.id);
  }
  if (toDrop.length) {
    bytes += await dropMediaFor(toDrop);
    removed += toDrop.length;
    await db.transaction('rw', db.posts, async () => {
      for (const id of toDrop) await db.posts.update(id, { savedAt: null, sizeBytes: 0 });
    });
  }
  let { usage } = await estimateStorage();
  if (usage > cap) {
    // Tniemy dalej, aż zmieścimy się w limicie (z zapasem 8%).
    const remaining = saved.filter((p) => !toDrop.includes(p.id));
    for (const post of remaining.reverse()) {
      if (usage <= cap * 0.92) break;
      const freed = await dropMediaFor([post.id]);
      await db.posts.update(post.id, { savedAt: null, sizeBytes: 0 });
      usage -= freed;
      bytes += freed;
      removed++;
    }
  }
  return { removed, bytes };
}

function shortUrl(url: string): string {
  const m = url.match(/([^/]+)(\?|$)/);
  return m?.[1]?.slice(0, 26) ?? url.slice(0, 26);
}
