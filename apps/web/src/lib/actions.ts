/**
 * Kolejka akcji do odtworzenia w X (polubienia i zakładki wysłane, gdy będzie łącze).
 *
 * Zapisujemy je zawsze — także gdy sieci nie ma wcale — bo celem jest „klikam w samolocie,
 * lecą po Wi-Fi”. Wysyłka realna istnieje wyłącznie w APK, gdzie apka ma Twoją sesję X
 * (patrz `bridge.ts` + `android/.../XLivePlugin.java`). W przeglądarce akcje grzecznie czekają.
 */
import { db } from '@/db/db';
import { useSettings } from './store';
import { isNative } from './transport';
import { bridge } from './bridge';
import type { ActionKind, ActionRow, PostRecord } from './types';

const kindFor = (liked: boolean): ActionKind => (liked ? 'like' : 'unlike');
const kindForBookmark = (marked: boolean): ActionKind => (marked ? 'bookmark' : 'unbookmark');

export async function enqueueAction(
  post: PostRecord,
  kind: ActionKind,
  origin: ActionRow['origin'] = 'offline-reader',
): Promise<number> {
  const row: ActionRow = {
    kind,
    tweetId: post.nativeId,
    tweetUrl: post.url,
    postId: post.id,
    authorHandle: post.authorHandle,
    snippet: post.text.slice(0, 140),
    status: 'pending',
    attempts: 0,
    createdAt: Date.now(),
    origin,
  };
  const id = await db.actions.add(row);
  void maybeReplay();
  return id as number;
}

export interface ToggleOutcome {
  kind: ActionKind;
  pending: boolean;
  sent: boolean;
  error?: string;
}

/** Polubienie z czytnika offline: zapisujemy stan lokalnie + dokładamy akcję do wysłania. */
export async function toggleLike(post: PostRecord): Promise<ToggleOutcome> {
  const next = !post.xLiked;
  await db.posts.update(post.id, { xLiked: next });
  const kind = kindFor(next);
  await enqueueAction(post, kind, 'offline-reader');
  return { kind, pending: true, sent: false };
}

/** Zakładka X z czytnika: przy dodaniu dbamy też o to, żeby post był w offline. */
export async function toggleBookmark(post: PostRecord, opts: { ensureOffline?: boolean } = {}): Promise<ToggleOutcome> {
  const next = !post.xBookmarked;
  await db.posts.update(post.id, { xBookmarked: next });
  const kind = kindForBookmark(next);
  await enqueueAction(post, kind, 'offline-reader');
  if (next && opts.ensureOffline !== false) {
    const { saveOffline } = await import('./posts');
    await saveOffline(post);
  }
  return { kind, pending: true, sent: false };
}

export async function pendingActions(limit = 25): Promise<ActionRow[]> {
  return db.actions.where('status').equals('pending').limit(limit).toArray();
}

/** Czy dla tego posta czeka już jakaś akcja (do dioda w UI). */
export async function hasPendingFor(postId: string): Promise<ActionRow | undefined> {
  return db.actions
    .where('status')
    .anyOf('pending', 'sending', 'error')
    .filter((a) => a.postId === postId)
    .first();
}

export async function pendingCount(): Promise<number> {
  return db.actions.where('status').equals('pending').count();
}

export async function actionStats(): Promise<{ pending: number; sent: number; error: number }> {
  const [pending, sent, error] = await Promise.all([
    db.actions.where('status').equals('pending').count(),
    db.actions.where('status').equals('sent').count(),
    db.actions.where('status').equals('error').count(),
  ]);
  return { pending, sent, error };
}

/** Znakuje partię jako „sending” i zwraca ją do transportu. */
export async function claimBatch(limit = 10): Promise<ActionRow[]> {
  const rows = await pendingActions(limit);
  for (const row of rows) if (row.id) await db.actions.update(row.id, { status: 'sending', attempts: (row.attempts ?? 0) + 1 });
  return rows;
}

export interface ReplayResult {
  id: number;
  ok: boolean;
  error?: string;
}

export async function reportResults(results: ReplayResult[]): Promise<void> {
  for (const res of results) {
    const row = await db.actions.get(res.id);
    if (!row) continue;
    await db.actions.update(res.id, {
      status: res.ok ? 'sent' : 'error',
      sentAt: res.ok ? Date.now() : null,
      error: res.ok ? undefined : (res.error ?? 'odrzucone przez X'),
    });
    if (row.postId) {
      const liked = row.kind === 'like';
      const marked = row.kind === 'bookmark';
      if (res.ok) {
        await db.posts.update(row.postId, liked ? { xLiked: true } : row.kind === 'unlike' ? { xLiked: false } : marked ? { xBookmarked: true } : { xBookmarked: false });
      } else {
        await db.posts.update(row.postId, { actionError: res.error ?? 'błąd wysyłki' });
      }
    }
  }
}

export async function discardAction(id: number): Promise<void> {
  await db.actions.delete(id);
}

export async function retryErrors(): Promise<number> {
  const rows = await db.actions.where('status').equals('error').toArray();
  for (const row of rows) if (row.id) await db.actions.update(row.id, { status: 'pending', error: undefined });
  return rows.length;
}

export async function clearSent(): Promise<number> {
  const ids = await db.actions.where('status').equals('sent').primaryKeys();
  await db.actions.bulkDelete(ids as number[]);
  return ids.length;
}

let replaying = false;

/** Próba wysłania zaległości. Wymaga natywnej sesji X (APK) — inaczej akcje zostają pending. */
export async function requeue(ids: Array<number | undefined>): Promise<void> {
  for (const id of ids) {
    if (!id) continue;
    const row = await db.actions.get(id);
    if (row && row.status === 'sending') await db.actions.update(id, { status: 'pending' });
  }
}

export async function maybeReplay(): Promise<{ sent: number; queued?: number; deferred: boolean; reason?: string }> {
  if (!useSettings.getState().online) return { sent: 0, deferred: true, reason: 'brak łącza' };
  if (!isNative() || !bridge.available()) {
    return { sent: 0, deferred: true, reason: 'wysyłka wymaga sesji X w aplikacji natywnej (APK)' };
  }
  if (replaying) return { sent: 0, deferred: true, reason: 'wysyłka już leci' };
  replaying = true;
  try {
    const batch = await claimBatch(10);
    if (!batch.length) return { sent: 0, deferred: false };
    const { queued } = await bridge.replayActions(batch);
    // Wyniki (co kliknęło, co nie) wracają eventem actionsDone → reportResults.
    return { sent: 0, queued, deferred: false };
  } catch (err) {
    await requeue((await pendingActions(50)).map((a) => a.id));
    return { sent: 0, deferred: true, reason: String((err as Error).message ?? err) };
  } finally {
    replaying = false;
  }
}
