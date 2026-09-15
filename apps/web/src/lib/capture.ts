/**
 * Przyjmowanie postów „z podsłuchu” (WebView w APK, import JSON, lustrzanka zakładek).
 * Tu mieszka polityka: co zapisujemy, kiedy przestajemy, kiedy odpuszczamy media.
 *
 * Zero danych zastępczych: jeśli nic nie przyszło z X, nic nie trafia do bazy.
 */
import { db } from '@/db/db';
import { normalizeTweets, type NormalizedPost } from './normalize';
import { upsertPosts } from './posts';
import { cachePostMedia, ensurePersistentStorage, trimSavedToTarget } from './media';
import { useSettings } from './store';
import { enqueueAction } from './actions';
import { logDiag } from './diagnostics';
import { rememberAccount } from './posts';
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
  handleHint?: string;
  /** Twardy sufit dla jednej partii. */
  maxPosts?: number;
  /** Którym kanałem post wszedł (UI pokazuje to w szczegółach). */
  origin?: PostOrigin;
}

function shouldCacheMedia(): { yes: boolean; reason?: string } {
  const { settings, online, netInfo } = useSettings.getState();
  if (!online) return { yes: false, reason: 'brak łącza — zapisujemy sam tekst' };
  if (settings.respectSaveData && netInfo.saveData) return { yes: false, reason: 'system oszczędza dane' };
  if (settings.mediaOnWifiOnly && /2g|3g/.test(netInfo.effectiveType ?? '')) {
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

/** Ta sama polityka, ale dla już znormalizowanych postów (ścieżka „dociągnij do N”). */
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
  const handles = new Set<string>();

  for (const post of posts) {
    const existing = await db.posts.get(post.id);

    // 1) zawsze odświeżamy treść w bazie (żeby czytnik był aktualny także online)
    const merged = await upsertPosts([{ ...post, origin: opts.origin ?? (isBookmarkMirror ? 'mirror' : 'live') }]);
    const row = merged[0];
    if (!row) continue;
    handles.add(row.authorHandle);

    // 2) decydujemy o zapisie offline. Rzeczy ważne (zakładka X, import, ręczny zapis)
    //    wchodzą ponad cel — limit dotyczy tylko „zbierania przy przewijaniu”.
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

    // 3) lustrzanka w drugą stronę: nasze zapisanie = zakładka w X (gdy będzie łącze)
    if (settings.mirrorToBookmarks && !row.xBookmarked) {
      await db.posts.update(row.id, { xBookmarked: true });
      await enqueueAction({ ...row, xBookmarked: true }, 'bookmark', 'mirror');
    }
  }

  report.added = saved;
  report.saved = saved;
  report.skipped = skipped;
  report.bytes = bytes;

  if (settings.trimOverTarget) {
    const trimmed = await trimSavedToTarget(settings.autoTarget);
    if (trimmed) report.reason = `przycięto ${trimmed} najstarszych (limit ${settings.autoTarget})`;
  }

  if (saved > 0) {
    void ensurePersistentStorage();
    noteCapture(
      `zapisano ${saved} ${saved === 1 ? 'post' : 'postów'}${isBookmarkMirror ? ' z zakładek X' : ''}` +
        `${bytes ? ` (${Math.round(bytes / 1024)} kB)` : ''}`,
      'ok',
    );
  }
  if (savedCount + saved >= settings.autoTarget) {
    report.reason ??= `limit ${settings.autoTarget} postów offline osiągnięty`;
  } else if (!wantMedia.yes) {
    report.reason ??= wantMedia.reason;
  }

  // Konto pojawia się na liście dopiero wtedy, gdy realnie coś od niego przyszło.
  for (const handle of handles) await rememberAccount(handle, { lastStatus: 'ok', fetchCount: 25 });

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
  return [
    ...new Set(
      raw
        .split(/[\s,;\n]+/)
        .map((h) => h.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/[/?#].*$/, ''))
        .filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)),
    ),
  ];
}

/** Log ostatniego zbierania — używane przez panel „na żywo” w APK. */
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
