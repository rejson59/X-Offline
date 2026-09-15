/**
 * Przyjmowanie postów z podglądu X (WebView w APK, import JSON, lustrzanka zakładek).
 * Tu mieszka polityka: co zapisujemy, kiedy przestajemy, kiedy odpuszczamy media.
 *
 * To jedyna droga postów do apki: jeśli nic nie przyszło z podglądu X, nic nie
 * trafia do bazy. Zero danych zastępczych, zero API, zero profili do śledzenia.
 */
import { db } from '@/db/db';
import { normalizeTweets, type NormalizedPost } from './normalize';
import { upsertPosts } from './posts';
import { cachePostMedia, ensurePersistentStorage } from './media';
import { useSettings } from './store';
import { logDiag } from './diagnostics';
import type { PostOrigin, PostRecord } from './types';

export interface CaptureReport {
  seen: number;
  added: number;
  saved: number;
  skipped: number;
  bytes: number;
  reason?: string;
}

export interface IngestOptions {
  via: NonNullable<PostRecord['via']>;
  /** Czy post przyszedł z widoku zakładek X. */
  source?: 'live-scroll' | 'bookmarks-mirror' | 'import';
  /** Omija `autoCapture` (używane przy ręcznym imporcie i świadomych ścieżkach). */
  force?: boolean;
  /** Twardy sufit dla jednej partii. */
  maxPosts?: number;
  /** Którym kanałem post wszedł (UI pokazuje to w szczegółach). */
  origin?: PostOrigin;
}

function shouldCacheMedia(): { yes: boolean; reason?: string } {
  const { settings, online, netInfo } = useSettings.getState();
  if (!online) return { yes: false, reason: 'brak łącza — zapisujemy sam tekst' };
  if (settings.respectSaveData && netInfo.saveData) return { yes: false, reason: 'system oszczędza dane' };
  return { yes: true };
}

export async function savedOfflineCount(): Promise<number> {
  return db.posts.where('savedAt').above(0).count();
}

/** Główny punkt wejścia: surowy payload (JSON lub tablica) → baza + offline. */
export async function ingestTweets(payload: unknown, opts: IngestOptions): Promise<CaptureReport> {
  const settings = useSettings.getState().settings;
  if (!settings.autoCapture && !opts.force) {
    return { seen: 0, added: 0, saved: 0, skipped: 0, bytes: 0, reason: 'auto-zapis wyłączony w ustawieniach' };
  }
  const posts: NormalizedPost[] = normalizeTweets(payload, 'syndication', {
    dropReplies: true,
    count: opts.maxPosts ?? 60,
  });
  if (!posts.length) {
    return { seen: 0, added: 0, saved: 0, skipped: 0, bytes: 0, reason: 'w payloadzie nie było postów' };
  }
  return await ingestPosts(posts, opts);
}

/** Ta sama polityka, ale dla już znormalizowanych postów. */
export async function ingestPosts(posts: NormalizedPost[], opts: IngestOptions): Promise<CaptureReport> {
  const report: CaptureReport = { seen: posts.length, added: 0, saved: 0, skipped: 0, bytes: 0 };
  const settings = useSettings.getState().settings;
  const isBookmarkMirror = opts.source === 'bookmarks-mirror';
  if (!settings.autoCapture && !opts.force) {
    return { ...report, seen: 0, reason: 'auto-zapis wyłączony w ustawieniach' };
  }
  if (!posts.length) {
    report.reason = 'brak postów do zapisania';
    return report;
  }

  const savedCount = await savedOfflineCount();
  let room = Math.max(0, settings.autoTarget - savedCount);
  const wantMedia = shouldCacheMedia();

  let saved = 0;
  let skipped = 0;
  let bytes = 0;

  for (const post of posts) {
    const existing = await db.posts.get(post.id);

    // 1) zawsze odświeżamy treść w bazie (żeby czytnik był aktualny także online)
    const merged = await upsertPosts([{ ...post, origin: opts.origin ?? (isBookmarkMirror ? 'mirror' : 'live') }]);
    const row = merged[0];
    if (!row) continue;

    // 2) decydujemy o zapisie offline. Rzeczy ważne (zakładka X, import)
    //    wchodzą ponad cel — limit dotyczy tylko zbierania przy przewijaniu.
    const bookmarked = Boolean(post.xBookmarked) && settings.mirrorBookmarks;
    const important = opts.via === 'import' || isBookmarkMirror || bookmarked;
    const alreadySaved = Boolean(existing?.savedAt);
    const overTarget = room <= 0 && !alreadySaved && !important;

    if (alreadySaved || overTarget) {
      skipped++;
      continue;
    }

    await db.posts.update(row.id, { savedAt: Date.now(), via: opts.via });
    saved++;
    room = Math.max(0, room - 1);

    if (wantMedia.yes && row.media.length) {
      const out = await cachePostMedia(row);
      bytes += out.bytes;
    }
  }

  report.added = saved;
  report.saved = saved;
  report.skipped = skipped;
  report.bytes = bytes;

  if (saved > 0) {
    void ensurePersistentStorage();
    noteCapture(
      `zapisano ${saved} ${saved === 1 ? 'post' : saved < 5 ? 'posty' : 'postów'}${isBookmarkMirror ? ' z zakładek X' : ''}` +
        `${bytes ? ` (${Math.round(bytes / 1024)} kB)` : ''}`,
      'ok',
    );
  }
  if (savedCount + saved >= settings.autoTarget) {
    report.reason ??= `limit ${settings.autoTarget} postów offline osiągnięty`;
  } else if (!wantMedia.yes) {
    report.reason ??= wantMedia.reason;
  }

  return report;
}

/** Log ostatniego zbierania — używany przez zakładkę X. */
export interface CaptureEvent {
  at: number;
  text: string;
  kind: 'info' | 'ok' | 'warn';
}

const captureLog: CaptureEvent[] = [];

export function noteCapture(text: string, kind: CaptureEvent['kind'] = 'info'): void {
  captureLog.unshift({ at: Date.now(), text, kind });
  if (captureLog.length > 60) captureLog.pop();
  if (kind === 'warn') logDiag('capture', text);
}

export function captureEvents(): CaptureEvent[] {
  return [...captureLog];
}
