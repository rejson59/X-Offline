import { db } from '@/db/db';
import { fetchBlob } from './transport';
import { logDiag } from './diagnostics';
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

export function revokeObjectUrl(key: string): void {
  const url = objectUrls.get(key);
  if (!url) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(key);
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

/** Media, których jeszcze nie mamy w IndexedDB (do „dociągnij brakujące”). */
export async function uncachedMediaOf(post: PostRecord): Promise<MediaItem[]> {
  const out: MediaItem[] = [];
  for (const item of post.media) {
    if (item.cached) continue;
    const row = await db.blobs.get(blobKey(item.url));
    if (!row) out.push(item);
  }
  return out;
}

/**
 * Pobiera i odkłada media posta w IndexedDB. Zwraca informację, co się udało —
 * tekst posta i tak zapisujemy, żeby „brak zasięgu” nie oznaczał „brak treści”.
 *
 * Każdy plik próbujemy raz; transport sam robi jedno ponowienie dla błędów przejściowych.
 * Pojedyncze niepowodzenie nie przerywa reszty (jedno zepsute zdjęcie nie może zepsuć posta).
 */
export async function cachePostMedia(post: PostRecord, signal?: AbortSignal): Promise<CacheOutcome> {
  const out: CacheOutcome = { bytes: 0, cached: 0, skipped: 0, errors: [] };
  const { settings } = useSettings.getState();

  if (shouldSkipMedia() && post.media.length) {
    return {
      bytes: 0,
      cached: 0,
      skipped: post.media.length,
      errors: ['pominięto media: oszczędzanie danych albo brak łącza'],
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
      await db.blobs.put({ key: blobKey(item.url), postId: post.id, url: item.url, mime, bytes, createdAt: Date.now(), blob });
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
      media[i] = { ...item, cached: true, bytes };
      out.bytes += bytes;
      out.cached++;
    } catch (err) {
      out.skipped++;
      out.errors.push(`${shortUrl(item.url)}: ${(err as Error).message}`);
    }
  }

  const sizeBytes = media.reduce((sum, m) => sum + (m.bytes ?? 0), 0);
  await db.posts.update(post.id, {
    media,
    sizeBytes,
    mediaError: out.errors.length ? out.errors.slice(0, 3).join('; ') : undefined,
  });
  if (out.errors.length) logDiag('warn', `media @${post.authorHandle}: ${out.errors[0]}`, out.errors.join('\n'));
  return out;
}

export async function dropMediaFor(postIds: string[]): Promise<number> {
  const rows = await db.blobs.where('postId').anyOf(postIds).toArray();
  await db.blobs.bulkDelete(rows.map((r) => r.key));
  for (const row of rows) revokeObjectUrl(row.key);
  return rows.reduce((s, r) => s + r.bytes, 0);
}

export async function estimateStorage(): Promise<{ usage: number; quota: number }> {
  if (!navigator.storage?.estimate) {
    const rows = await db.blobs.toArray();
    return { usage: rows.reduce((acc, b) => acc + b.bytes, 0), quota: 0 };
  }
  const est = await navigator.storage.estimate();
  return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
}

/** Bajty faktycznie trzymane w naszej bazie (teksty pomijamy — są małe). */
export async function mediaBytes(): Promise<number> {
  const rows = await db.blobs.toArray();
  return rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
}

/**
 * Prosi system o „trwałe” miejsce dla IndexedDB. Bez tego Chrome/Android może
 * wyrzucić zapisane posty przy braku miejsca — a to jest cały sens apki.
 */
export async function ensurePersistentStorage(): Promise<boolean> {
  try {
    if (!useSettings.getState().settings.persistStorage) return false;
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface PruneResult {
  /** Ile postów straciło media (same posty zostają — czytasz dalej tekst). */
  removed: number;
  bytes: number;
  /** Ile postów w ogóle nie ruszono. */
  kept: number;
  reason?: string;
}

/**
 * Trzyma cache w ryzach: zrzuca *media* najstarszych zapisów, ale nie kasuje postów.
 *
 * Wcześniej ta funkcja ustawiała `savedAt: null`, czyli cicho wyrzucała posty z biblioteki
 * (tekst też znikał z „Zapisanych”). Teraz zachowanie jest takie, jak opisuje je UI:
 * treść zostaje, media najstarszych postów lecą precz — a jak nadal brakuje miejsca,
 * schodzimy dalej po najstarszych, dopóki nie zmieścimy się w limicie.
 */
export async function pruneToCap(capMb: number, keepPosts: number): Promise<PruneResult> {
  if (!capMb) return { removed: 0, bytes: 0, kept: 0 };
  const savedRows = await db.posts.where('savedAt').above(0).toArray();
  const saved = savedRows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  const cap = capMb * 1024 * 1024;

  const toDrop: PostRecord[] = [];
  const keep = Math.max(0, keepPosts);
  saved.forEach((post, idx) => {
    const hasMedia = post.media.some((m) => m.cached);
    if (idx >= keep && hasMedia) toDrop.push(post);
  });

  let bytes = 0;
  let removed = 0;
  for (const post of toDrop) {
    bytes += await dropMediaFor([post.id]);
    await db.posts.update(post.id, {
      media: post.media.map((m) => ({ ...m, cached: false, bytes: undefined, poster: m.kind === 'video' ? m.poster : undefined })),
      sizeBytes: 0,
      mediaError: 'media usunięte przez auto-czyszczenie (limit miejsca)',
    });
    removed++;
  }

  let used = await mediaBytes();
  if (used > cap) {
    const remaining = saved.filter((p) => !toDrop.includes(p));
    for (const post of [...remaining].reverse()) {
      if (used <= cap * 0.92) break;
      if (!post.media.some((m) => m.cached)) continue;
      const freed = await dropMediaFor([post.id]);
      await db.posts.update(post.id, {
        media: post.media.map((m) => ({ ...m, cached: false, bytes: undefined })),
        sizeBytes: 0,
        mediaError: 'media usunięte przez auto-czyszczenie (limit miejsca)',
      });
      used -= freed;
      bytes += freed;
      removed++;
    }
  }

  if (removed) logDiag('info', `auto-czyszczenie: ${removed} postów bez mediów (${bytes} B zwolnione)`);
  return {
    removed,
    bytes,
    kept: Math.max(0, saved.length - removed),
    reason: removed ? 'zrzucono media najstarszych zapisów' : 'miejsce w normie',
  };
}

/**
 * Awaryjne zwalnianie miejsca, gdy IndexedDB odmawia zapisu (`QuotaExceededError`).
 *
 * `pruneToCap` respektuje okno najnowszych postów — a gdy telefon jest pełny, nie ma czego
 * oszczędzać: zrzucamy media od najstarszych zapisów, aż uzbiera się `targetBytes`.
 * Zasada bez zmian: giną pliki, teksty postów zostają (czytasz dalej, tylko bez grafiki).
 */
export async function freeMediaForWrite(targetBytes = 4 * 1024 * 1024): Promise<number> {
  const saved = (await db.posts.where('savedAt').above(0).toArray()).sort(
    (a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0),
  );
  let freed = 0;
  for (const post of saved) {
    if (freed >= targetBytes) break;
    if (!post.media.some((m) => m.cached)) continue;
    freed += await dropMediaFor([post.id]);
    await db.posts.update(post.id, {
      media: post.media.map((m) => ({ ...m, cached: false, bytes: undefined })),
      sizeBytes: 0,
      mediaError: 'media usunięte, żeby zwolnić miejsce na nowe posty',
    });
  }
  if (freed) logDiag('warn', `brakło miejsca w pamięci urządzenia — zrzucone media najstarszych zapisów (${freed} B)`);
  return freed;
}

/**
 * Twarde przycięcie do celu: usuwa z offline najstarsze posty powyżej `target`
 * (razem z mediami). Włączane świadomie ustawieniem „Przytnij nadmiar ponad cel”.
 */
export async function trimSavedToTarget(target: number): Promise<number> {
  if (!target) return 0;
  const saved = await db.posts.where('savedAt').above(0).toArray();
  if (saved.length <= target) return 0;
  const oldest = saved.sort((a, b) => (a.savedAt ?? 0) - (b.savedAt ?? 0)).slice(0, saved.length - target);
  await dropMediaFor(oldest.map((p) => p.id));
  await db.transaction('rw', db.posts, async () => {
    for (const post of oldest) {
      await db.posts.update(post.id, {
        savedAt: null,
        sizeBytes: 0,
        media: post.media.map((m) => ({ ...m, cached: false, bytes: undefined })),
      });
    }
  });
  logDiag('info', `przycięto offline do ${target} postów (usunięto ${oldest.length})`);
  return oldest.length;
}

function shortUrl(url: string): string {
  const m = url.match(/([^/]+)(\?|$)/);
  return m?.[1]?.slice(0, 26) ?? url.slice(0, 26);
}
