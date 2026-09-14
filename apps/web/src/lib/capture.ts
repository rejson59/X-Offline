/**
 * Przyjmowanie postów „z podsłuchu” (WebView w APK, import JSON, lustrzanka zakładek).
 * Tu mieszka polityka: co zapisujemy, kiedy przestajemy, kiedy odpuszczamy media.
 */
import { db } from '@/db/db';
import { normalizeTweets, type NormalizedPost } from './normalize';
import { upsertPosts } from './posts';
import { cachePostMedia } from './media';
import { useSettings } from './store';
import { enqueueAction } from './actions';
import type { PostRecord } from './types';

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
  /** Omija `autoCapture` (używane przy ręcznym imporcie i eksportowalnych ścieżkach). */
  force?: boolean;
  handleHint?: string;
  /** Twardy sufit dla jednej partii. */
  maxPosts?: number;
}

function shouldCacheMedia(): { yes: boolean; reason?: string } {
  const { settings, online, netInfo } = useSettings.getState();
  if (!online) return { yes: false, reason: 'brak łącza — zapisujemy sam tekst' };
  if (settings.respectSaveData && netInfo.saveData) return { yes: false, reason: 'system oszczędza dane' };
  if (settings.mediaOnWifiOnly && (netInfo.effectiveType ?? '').includes('3g')) {
    return { yes: false, reason: 'media tylko na Wi-Fi' };
  }
  return { yes: true };
}

export async function savedOfflineCount(): Promise<number> {
  return db.posts.where('savedAt').above(0).count();
}

/** Główny punkt wejścia: surowy payload (JSON lub tablica) → baza + offline. */
export async function ingestTweets(payload: unknown, opts: IngestOptions): Promise<CaptureReport> {
  const settings = useSettings.getState().settings;
  if (!settings.autoCapture && !opts.force && opts.via === 'auto-scroll') {
    return { seen: 0, added: 0, saved: 0, skipped: 0, bytes: 0, reason: 'auto-zapis wyłączony w ustawieniach' };
  }
  const posts: NormalizedPost[] = normalizeTweets(payload, 'syndication', {
    dropReplies: true,
    count: opts.maxPosts ?? 60,
  });
  return await ingestPosts(posts, opts);
}

/** Ta sama polityka, ale dla już znormalizowanych postów (ścieżka „dociągnij do N”). */
export async function ingestPosts(
  posts: NormalizedPost[],
  opts: IngestOptions & { maxPosts?: number },
): Promise<CaptureReport> {
  const report: CaptureReport = { seen: posts.length, added: 0, saved: 0, skipped: 0, bytes: 0 };
  const settings = useSettings.getState().settings;
  if (!settings.autoCapture && !opts.force && opts.via === 'auto-scroll') {
    return { ...report, seen: 0, reason: 'auto-zapis wyłączony w ustawieniach' };
  }
  if (!posts.length) {
    report.reason = 'brak postów do zapisania';
    return report;
  }

  const savedCount = await savedOfflineCount();
  const room = Math.max(0, settings.autoTarget - savedCount);
  const wantMedia = shouldCacheMedia();

  let added = 0;
  let saved = 0;
  let bytes = 0;
  let skipped = 0;

  for (const post of posts) {
    const existing = await db.posts.get(post.id);
    const needsSave = opts.via === 'import' || opts.source === 'bookmarks-mirror' || post.xBookmarked || !existing?.savedAt;

    // 1) zawsze aktualizujemy treść w bazie (żeby czytnik był świeży, też online)
    const merged = await upsertPosts([post]);
    const row = merged[0];

    // 2) decydujemy o zapisie offline. Rzeczy ważne (zakładka X, import, ręczny zapis)
    //    wchodzą ponad cel — limit dotyczy tylko „zbierania przy przewijaniu”.
    const important = opts.via === 'import' || opts.source === 'bookmarks-mirror' || post.xBookmarked;
    const overTarget = saved >= room && !existing?.savedAt && !important;
    if (!needsSave || overTarget) {
      skipped++;
      continue;
    }
    await db.posts.update(row.id, { savedAt: Date.now(), via: opts.via });
    saved++;
    added++;

    if (wantMedia.yes && row.media.length) {
      const out = await cachePostMedia(row);
      bytes += out.bytes;
    }

    // 3) lustrzanka w drugą stronę: nasze zapisanie = zakładka w X (gdy będzie łącze)
    if (settings.mirrorToBookmarks && !row.xBookmarked) {
      await db.posts.update(row.id, { xBookmarked: true });
      await enqueueAction({ ...row, xBookmarked: true }, 'bookmark', 'mirror');
    }
  }

  report.added = added;
  report.saved = saved;
  report.skipped = skipped;
  report.bytes = bytes;
  if (skipped > 0 && savedCount + saved >= settings.autoTarget) {
    report.reason = `limit ${settings.autoTarget} postów offline osiągnięty`;
  } else if (room === 0) {
    report.reason = `limit ${settings.autoTarget} postów offline już osiągnięty`;
  } else if (!wantMedia.yes) {
    report.reason = wantMedia.reason;
  }
  await refreshCounters();
  return report;
}

async function refreshCounters(): Promise<void> {
  const [{ refreshAccountCounts }, { useQueue }] = await Promise.all([import('./posts'), import('./download')]);
  await refreshAccountCounts();
  await useQueue.getState().refreshTotals();
}

/** Do czego służymy w trybie bez natywnego podglądu: lista kont z ustawień. */
export function followHandles(): string[] {
  const raw = useSettings.getState().settings.followList ?? '';
  return [...new Set(raw.split(/[\s,;\n]+/).map((h) => h.trim().replace(/^@/, '')).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)))];
}
