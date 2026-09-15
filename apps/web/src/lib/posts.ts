import { db } from '@/db/db';
import { cachePostMedia, dropMediaFor, ensurePersistentStorage, freeMediaForWrite, pruneToCap, uncachedMediaOf } from './media';
import { logDiag } from './diagnostics';
import { useSettings } from './store';
import type { PostRecord } from './types';

/**
 * Wstawia/aktualizuje posty, zachowując to, co już zostało pobrane do offline.
 *
 * Zasada: sieć nigdy nie cofa tego, co zrobił użytkownik. Flagi `savedAt`, `readAt`,
 * polubienia/zakładki z kolejki i pobrane media zostają nietknięte przy odświeżeniu.
 */
export async function upsertPosts(posts: PostRecord[]): Promise<PostRecord[]> {
  const merged: PostRecord[] = [];
  // Jeśli dla posta czeka akcja (polubienie/zakładka kliknięte offline), NIE nadpisujemy
  // tych flag tym, co mówi serwer — inaczej świeżo pobrany post „anulowałby” nasz zamiar.
  const queued = await db.actions.where('status').anyOf('pending', 'sending').toArray();
  const queuedIds = new Set(queued.map((a) => a.tweetId));
  await db.transaction('rw', db.posts, async () => {
    for (const post of posts) {
      const existing = await db.posts.get(post.id);
      const keepInteractions = Boolean(existing) && queuedIds.has(existing!.nativeId);
      const next: PostRecord = {
        ...post,
        savedAt: existing?.savedAt ?? post.savedAt ?? null,
        readAt: existing?.readAt ?? post.readAt ?? null,
        sizeBytes: existing?.sizeBytes ?? post.sizeBytes ?? 0,
        origin: post.origin ?? existing?.origin,
        via: existing?.via ?? post.via,
        mediaError: existing?.mediaError,
        xLiked: keepInteractions ? existing!.xLiked : (post.xLiked ?? existing?.xLiked ?? false),
        xBookmarked: keepInteractions ? existing!.xBookmarked : (post.xBookmarked ?? existing?.xBookmarked ?? false),
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

/**
 * Zapis rekordu posta z ratunkiem na „brak miejsca”.
 *
 * Gdy w telefonie kończy się pamięć, IndexedDB zgłasza `QuotaExceededError` i **cały** zapis
 * przepadał — a to najgorszy możliwy scenariusz w apce, której sens polega na tym, żeby posty
 * były zapisane. Zamiast tego zwalniamy miejsce (media najstarszych zapisów, dokładnie tak jak
 * auto-czyszczenie) i próbujemy jeszcze raz, a jak nadal nie ma gdzie pisać — mówimy wprost,
 * co się stało, po polsku.
 */
async function writePostRow(row: PostRecord): Promise<void> {
  try {
    await db.posts.put(row);
    return;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    // 1) Najpierw to, co zawsze pomaga: media najstarszych zapisów (teksty zostają).
    let freed = await freeMediaForWrite();
    // 2) Dopiero potem zwykłe przycinanie do limitu — gdyby tamto nie miało czego zrzucić.
    if (!freed) {
      const { settings } = useSettings.getState();
      freed = (await pruneToCap(settings.storageCapMb || 256, Math.max(0, settings.pruneKeepPosts))).bytes;
    }
    logDiag('warn', `brakło miejsca na zapis — zwolniłem ${freed} B`);
    try {
      await db.posts.put(row);
    } catch (err2) {
      if (isQuotaError(err2)) {
        throw new Error('Brak miejsca na urządzeniu — zwolnij trochę pamięci albo podnieś „Limit offline”.');
      }
      throw err2;
    }
  }
}

function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number; message?: string };
  return e?.name === 'QuotaExceededError' || e?.code === 22 || /quota|storage full/i.test(String(e?.message ?? ''));
}

export interface SaveOutcome {
  ok: boolean;
  bytes: number;
  cached: number;
  skipped: number;
  errors: string[];
  /** Media zostały w chmurze — do dociągnięcia później. */
  pendingMedia: number;
}

/**
 * Zapis posta + mediów do offline.
 *
 * Kolejność ma znaczenie: najpierw oznaczamy post jako zapisany (tekst jest w bazie od razu,
 * nawet bez sieci), potem dociągamy media. Dzięki temu „Zapisane” nigdy nie jest puste,
 * a nieudane media da się później dociągnąć jednym kliknięciem („brakujące media”).
 */
export async function saveOffline(post: PostRecord, signal?: AbortSignal): Promise<SaveOutcome> {
  const existing = await db.posts.get(post.id);
  if (!existing && !post.text && !post.media.length) {
    throw new Error('Nie ma czego zapisywać — post jest pusty.');
  }
  const base = existing ?? post;
  const row = {
    ...base,
    ...post,
    savedAt: base.savedAt ?? Date.now(),
    readAt: base.readAt ?? post.readAt ?? null,
    // Interakcje z czytnika są ważniejsze niż to, co akurat mówi świeżo pobrany post.
    xLiked: post.xLiked ?? base.xLiked,
    xBookmarked: post.xBookmarked ?? base.xBookmarked,
    sizeBytes: base.sizeBytes ?? 0,
    media:
      post.media.length ?
        post.media.map((m) => {
          const prev = base.media.find((x) => x.url === m.url);
          return prev?.cached ? { ...m, cached: true, bytes: prev.bytes } : { ...m, cached: false, bytes: undefined };
        })
      : base.media,
    via: post.via ?? base.via ?? 'manual',
  };
  await writePostRow(row);
  // Post jest już w bibliotece — od tego miejsca nic nie może wywalić zapisu.
  void ensurePersistentStorage();

  const outcome = await cachePostMedia(post, signal);
  const fresh = (await db.posts.get(post.id)) ?? post;
  const pending = await uncachedMediaOf(fresh);

  await refreshAccountCounts();
  if (!outcome.cached && outcome.errors.length) {
    logDiag('info', `zapisano sam tekst @${post.authorHandle}`, outcome.errors.join('\n'));
  }
  return {
    ok: true,
    bytes: outcome.bytes,
    cached: outcome.cached,
    skipped: outcome.skipped,
    errors: outcome.errors,
    pendingMedia: pending.length,
  };
}

/**
 * Dociąga brakujące media dla wskazanych (albo wszystkich) zapisanych postów.
 * Używane przez „Dociągnij brakujące” w kolejce i po powrocie łącza.
 */
export async function fetchMissingMedia(ids?: string[]): Promise<{ posts: number; bytes: number; failed: number }> {
  const rows =
    ids?.length ?
      ((await db.posts.bulkGet(ids)).filter(Boolean) as PostRecord[])
    : await db.posts.where('savedAt').above(0).toArray();
  let bytes = 0;
  let posts = 0;
  let failed = 0;
  for (const post of rows) {
    if (!post.media.length) continue;
    const missing = await uncachedMediaOf(post);
    if (!missing.length) continue;
    const out = await cachePostMedia(post);
    if (out.cached) posts++;
    bytes += out.bytes;
    failed += out.skipped;
    await new Promise((r) => setTimeout(r, 120));
  }
  await refreshAccountCounts();
  return { posts, bytes, failed };
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
        mediaError: undefined,
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
  await refreshAccountCounts();
}

/** Oznacza posty jako przeczytane / nieprzeczytane. */
export async function markRead(ids: string[], read = true): Promise<void> {
  const value = read ? Date.now() : null;
  await db.transaction('rw', db.posts, async () => {
    for (const id of ids) await db.posts.update(id, { readAt: value });
  });
}

export async function countUnread(): Promise<number> {
  const saved = await db.posts.where('savedAt').above(0).toArray();
  return saved.filter((p) => !p.readAt).length;
}

/** Kiedy ostatnio czytaliśmy cokolwiek — do „Czytaj dalej”. */
export async function lastRead(): Promise<PostRecord | undefined> {
  const saved = await db.posts.where('savedAt').above(0).toArray();
  return saved
    .filter((p) => p.readAt)
    .sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0))[0];
}

export async function refreshAccountCounts(): Promise<void> {
  const rows = await db.posts.where('savedAt').above(0).toArray();
  const byHandle = new Map<string, number>();
  for (const p of rows) byHandle.set(p.authorHandle, (byHandle.get(p.authorHandle) ?? 0) + 1);
  const accounts = await db.accounts.toArray();
  for (const acc of accounts) {
    const saved = byHandle.get(acc.handle) ?? 0;
    if (saved !== acc.savedCount) await db.accounts.update(acc.handle, { savedCount: saved });
  }
}

export function savedPostsQuery() {
  return db.posts.where('savedAt').above(0);
}

/** Zapamiętuje realny profil na liście kont (kolejka i auto-dociąganie jej używają). */
export async function rememberAccount(
  handle: string,
  patch: Partial<{ name: string; avatar: string; description: string; followers: number; lastStatus: string; lastError?: string; fetchCount: number }> = {},
): Promise<void> {
  const existing = await db.accounts.get(handle);
  await db.accounts.put({
    handle,
    origin: existing?.origin ?? 'manual',
    autoSync: existing?.autoSync ?? true,
    fetchCount: existing?.fetchCount ?? patch.fetchCount ?? 25,
    ...existing,
    ...patch,
    lastSyncAt: patch.lastStatus === 'ok' ? Date.now() : (existing?.lastSyncAt ?? null),
  });
}

export interface LibraryExport {
  app: 'x-offline';
  version: 2;
  exportedAt: string;
  posts: PostRecord[];
  accounts: { handle: string; name?: string }[];
}

export async function exportLibrary(): Promise<LibraryExport> {
  const posts = await db.posts.where('savedAt').above(0).toArray();
  const accounts = await db.accounts.toArray();
  return {
    app: 'x-offline',
    version: 2,
    exportedAt: new Date().toISOString(),
    posts,
    accounts: accounts.map((a) => ({ handle: a.handle, name: a.name })),
  };
}

/** Czytelny eksport — jeden plik Markdown, który otworzysz w czymkolwiek. */
export async function exportMarkdown(): Promise<{ name: string; text: string; posts: number }> {
  const posts = (await db.posts.where('savedAt').above(0).toArray()).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  const lines: string[] = [
    '# X-Offline — zapisane posty',
    '',
    `Wyeksportowano ${new Date().toLocaleString('pl-PL')} · ${posts.length} postów · działa bez internetu.`,
    '',
  ];
  for (const post of posts) {
    lines.push(`## @${post.authorHandle} — ${new Date(post.createdAt).toLocaleString('pl-PL')}`);
    lines.push('');
    lines.push(post.text.trim() || '_(post bez tekstu)_');
    lines.push('');
    if (post.url) lines.push(`Źródło: ${post.url}`);
    if (post.media.length) {
      lines.push('');
      for (const m of post.media) lines.push(`- ${m.kind}: ${m.url}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return { name: `xoffline-${new Date().toISOString().slice(0, 10)}.md`, text: lines.join('\n'), posts: posts.length };
}

export async function importLibrary(payload: unknown): Promise<{ posts: number; bytes: number; failed: number }> {
  const lib = payload as Partial<LibraryExport>;
  if (!lib || lib.app !== 'x-offline' || !Array.isArray(lib.posts)) {
    throw new Error('To nie jest plik biblioteki X-Offline (oczekiwano pola „app”: „x-offline”).');
  }
  let bytes = 0;
  let saved = 0;
  let failed = 0;
  for (const post of lib.posts) {
    if (!post?.id || typeof post.text !== 'string') {
      failed++;
      continue;
    }
    const clean: PostRecord = {
      ...post,
      source: 'library',
      savedAt: post.savedAt ?? Date.now(),
      media: (post.media ?? []).map((m) => ({ ...m, cached: false, bytes: undefined })),
      sizeBytes: 0,
      fetchedFrom: 'library',
      origin: 'import',
    };
    await db.posts.put(clean);
    saved++;
    if (clean.media.length) {
      const out = await cachePostMedia(clean);
      bytes += out.bytes;
      failed += out.skipped;
    }
  }
  if (Array.isArray(lib.accounts)) {
    for (const acc of lib.accounts) {
      if (acc?.handle) await rememberAccount(acc.handle, { name: acc.name, lastStatus: 'imported' });
    }
  }
  await refreshAccountCounts();
  void ensurePersistentStorage();
  return { posts: saved, bytes, failed };
}

/** Ile postów w ogóle mamy w bazie i ile z nich jest w offline (dla statystyk w UI). */
export async function libraryStats(): Promise<{ all: number; saved: number; unread: number; bytes: number }> {
  const [all, saved] = await Promise.all([db.posts.count(), db.posts.where('savedAt').above(0).toArray()]);
  return {
    all,
    saved: saved.length,
    unread: saved.filter((p) => !p.readAt).length,
    bytes: saved.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0),
  };
}

/** Czy użytkownik ma już cokolwiek do czytania (decyduje o „pierwszym uruchomieniu”). */
export async function hasAnySaved(): Promise<boolean> {
  return (await db.posts.where('savedAt').above(0).count()) > 0;
}

/** Ostatnio zapisany post — dla podpowiedzi „kontynuuj czytanie”. */
export async function latestSaved(): Promise<PostRecord | undefined> {
  const rows = await db.posts.where('savedAt').above(0).reverse().sortBy('savedAt');
  return rows[0];
}

export function cachedMediaCount(post: PostRecord): number {
  return post.media.filter((m) => m.cached).length;
}

export function mediaPending(post: PostRecord): boolean {
  return post.media.some((m) => !m.cached);
}

/** Ustawienia, które wpływają na zapis — jedno miejsce prawdy dla UI. */
export function saveHints(): string[] {
  const { settings, online } = useSettings.getState();
  const hints: string[] = [];
  if (!online) hints.push('brak łącza — zapiszemy sam tekst');
  if (!settings.downloadVideo) hints.push('wideo wyłączone w ustawieniach');
  if (settings.storageCapMb) hints.push(`limit miejsca: ${settings.storageCapMb} MB`);
  return hints;
}
