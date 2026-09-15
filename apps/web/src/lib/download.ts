/**
 * Kolejka pobierania. Prosta, ale z tym, co ważne na słabym łączu:
 * postęp per zadanie, anulowanie, ponowienie, ograniczona równoległość, historia w IndexedDB.
 */
import { create } from 'zustand';
import { db } from '@/db/db';
import { fetchPostsByLinks, fetchProfile, type FetchResult } from './sources';
import { saveOffline, upsertPosts, refreshAccountCounts } from './posts';
import { pruneToCap } from './media';
import { useSettings } from './store';
import { logError, logDiag } from './diagnostics';
import { noteCapture } from './capture';
import type { JobRow, PostRecord } from './types';

export type TaskType = 'profile' | 'links';
export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Task {
  id: string;
  jobId?: number;
  type: TaskType;
  label: string;
  status: TaskStatus;
  total: number;
  done: number;
  bytes: number;
  errors: string[];
  /** Uchwycone dane wejściowe (tylko w pamięci, nie zapisujemy ich w historii). */
  payload?: { handle?: string; links?: string[] };
  upstream?: string;
  startedAt: number;
  finishedAt?: number;
  hint?: string;
}

interface QueueState {
  tasks: Task[];
  running: boolean;
  savedCount: number;
  totalBytes: number;
  enqueueProfile: (handles: string[], count?: number) => Promise<number>;
  enqueueLinks: (links: string[]) => Promise<number>;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  cancelAll: () => void;
  clearFinished: () => void;
  refreshTotals: () => Promise<void>;
}

const controllers = new Map<string, AbortController>();
const uid = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Ustawia status konta na liście — bez tego użytkownik nie wie, czemu profil nic nie dał. */
async function setAccountStatus(handle: string, status: string, error?: string): Promise<void> {
  const existing = await db.accounts.get(handle);
  if (!existing) return;
  await db.accounts.update(handle, { lastStatus: status, lastError: error, lastSyncAt: status === 'ok' ? Date.now() : existing.lastSyncAt });
}

export const useQueue = create<QueueState>((set, get) => {
  const patchTask = (id: string, patch: Partial<Task>) =>
    set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  return {
    tasks: [],
    running: false,
    savedCount: 0,
    totalBytes: 0,

    enqueueProfile: async (handles, count) => {
      const perHandle = Math.max(1, Math.min(count ?? 25, 100));
      const clean = [...new Set(handles.map((h) => h.trim().replace(/^@/, '')).filter((h) => /^[A-Za-z0-9_]{1,15}$/.test(h)))];
      if (!clean.length) return 0;
      const tasks: Task[] = [];
      for (const h of clean) {
        const label = `@${h} — ${perHandle} ostatnich postów`;
        const jobId = await db.jobs.add({
          type: 'profile',
          label,
          status: 'queued',
          total: perHandle,
          done: 0,
          bytes: 0,
          errors: [],
          createdAt: Date.now(),
        } satisfies JobRow);
        tasks.push({
          id: uid(),
          jobId,
          type: 'profile',
          label,
          status: 'queued',
          total: perHandle,
          done: 0,
          bytes: 0,
          errors: [],
          payload: { handle: h },
          startedAt: Date.now(),
        });
      }
      set({ tasks: [...tasks, ...get().tasks] });
      void pump(set, get, patchTask);
      return tasks.length;
    },

    enqueueLinks: async (links) => {
      const clean = [...new Set(links.map((l) => l.trim()).filter(Boolean))];
      if (!clean.length) return 0;
      const label = `Import z linków (${clean.length})`;
      const jobId = await db.jobs.add({
        type: 'links',
        label,
        status: 'queued',
        total: clean.length,
        done: 0,
        bytes: 0,
        errors: [],
        createdAt: Date.now(),
      } satisfies JobRow);
      const task: Task = {
        id: uid(),
        jobId,
        type: 'links',
        label,
        status: 'queued',
        total: clean.length,
        done: 0,
        bytes: 0,
        errors: [],
        payload: { links: clean },
        startedAt: Date.now(),
      };
      set({ tasks: [task, ...get().tasks] });
      void pump(set, get, patchTask);
      return 1;
    },

    retry: (id) => {
      const task = get().tasks.find((t) => t.id === id);
      if (!task || task.status === 'running' || task.status === 'queued') return;
      patchTask(id, { status: 'queued', done: 0, bytes: 0, errors: [], hint: undefined, startedAt: Date.now(), finishedAt: undefined });
      void pump(set, get, patchTask);
    },

    cancel: (id) => {
      controllers.get(id)?.abort();
      patchTask(id, { status: 'cancelled', finishedAt: Date.now() });
    },

    cancelAll: () => {
      controllers.forEach((c) => c.abort());
      set({
        tasks: get().tasks.map((t) =>
          t.status === 'queued' || t.status === 'running' ? { ...t, status: 'cancelled' as TaskStatus, finishedAt: Date.now() } : t,
        ),
      });
    },

    clearFinished: () => set({ tasks: get().tasks.filter((t) => t.status === 'queued' || t.status === 'running') }),

    refreshTotals: async () => {
      const rows = await db.posts.where('savedAt').above(0).toArray();
      set({
        savedCount: rows.length,
        totalBytes: rows.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0),
      });
    },
  };
});

type SetFn = (partial: Partial<QueueState> | ((s: QueueState) => Partial<QueueState>)) => void;
type GetFn = () => QueueState;
type PatchFn = (id: string, patch: Partial<Task>) => void;

let pumping = false;

async function pump(set: SetFn, get: GetFn, patchTask: PatchFn): Promise<void> {
  if (pumping) return;
  pumping = true;
  set({ running: true });
  try {
    while (true) {
      const task = get().tasks.find((t) => t.status === 'queued');
      if (!task) break;
      const controller = new AbortController();
      controllers.set(task.id, controller);
      patchTask(task.id, { status: 'running', startedAt: Date.now(), errors: [], hint: undefined });

      let savedCount = 0;
      let bytes = 0;
      let failures: string[] = [];
      let fatal: string | undefined;
      let hint: string | undefined;

      try {
        const settings = useSettings.getState().settings;
        const online = useSettings.getState().online;
        if (!online) throw new Error('Brak łącza — kolejka poczeka, aż wrócisz do sieci.');

        let posts: PostRecord[] = [];
        let upstream = 'x';
        let result: FetchResult | null = null;

        if (task.type === 'links' && task.payload?.links) {
          result = await fetchPostsByLinks(task.payload.links, (done, total) => patchTask(task.id, { done, total }));
        } else if (task.type === 'profile' && task.payload?.handle) {
          result = await fetchProfile(task.payload.handle, task.total || 25);
        }

        if (result) {
          posts = result.posts;
          upstream = result.upstream;
          if (!posts.length) {
            fatal = result.error ?? 'Brak wyników';
            hint = result.hint;
            failures.push(...[result.error, result.hint].filter(Boolean) as string[]);
          } else if (result.error) {
            failures.push(result.error);
          }
        }

        const saved = await upsertPosts(posts);
        if (saved.length) {
          patchTask(task.id, { total: saved.length, upstream });
        }

        // Media lecą równolegle, ale max 3 na raz — więcej i słabe łącze się dławi.
        let done = 0;
        await runPool(
          saved,
          Math.min(3, Math.max(1, saved.length)),
          async (post) => {
            if (controller.signal.aborted) return;
            try {
              const out = await saveOffline(post, controller.signal);
              bytes += out.bytes;
              if (out.errors.length) failures.push(`${post.authorHandle}: ${out.errors[0]}`);
            } catch (err) {
              failures.push(`${post.authorHandle}: ${(err as Error).message}`);
              logError('zapis posta', err);
            } finally {
              patchTask(task.id, { bytes, done: ++done });
            }
          },
        );
        savedCount = saved.length;

        if (task.payload?.handle) {
          await setAccountStatus(task.payload.handle, savedCount ? 'ok' : 'empty', savedCount ? undefined : (fatal ?? undefined));
        }

        if (settings.storageCapMb && settings.autoPrune) {
          const pruned = await pruneToCap(settings.storageCapMb, settings.pruneKeepPosts);
          if (pruned.removed) noteCapture(`auto-czyszczenie: ${pruned.removed} postów bez mediów`, 'warn');
        }
      } catch (err) {
        fatal = String((err as Error).message ?? err);
        if (task.payload?.handle) await setAccountStatus(task.payload.handle, 'error', fatal);
        logError(`pobieranie ${task.label}`, err);
      } finally {
        controllers.delete(task.id);
      }

      await refreshAccountCounts().catch(() => undefined);
      await useQueue.getState().refreshTotals().catch(() => undefined);
      const status: TaskStatus = controller.signal.aborted ? 'cancelled' : fatal ? 'error' : 'done';
      patchTask(task.id, {
        status,
        bytes,
        errors: failures.slice(0, 5),
        hint,
        finishedAt: Date.now(),
        done: status === 'done' ? savedCount : task.total,
      });
      if (status === 'done' && savedCount) {
        noteCapture(`${task.label}: zapisane ${savedCount} postów${bytes ? ` (${Math.round(bytes / 1024)} kB)` : ''}`, 'ok');
      }
      if (task.jobId) {
        const update: Partial<JobRow> = {
          status,
          done: savedCount,
          bytes,
          errors: failures.slice(0, 5),
          finishedAt: Date.now(),
        };
        if (fatal) update.lastError = fatal;
        await db.jobs.update(task.jobId, update).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (err) {
    // Awaria pętli kolejki nie może wywalić apki — ląduje w dzienniku i tyle.
    logDiag('error', `kolejka pobierania stanęła: ${(err as Error).message}`, (err as Error).stack);
  } finally {
    pumping = false;
    set({ running: false });
  }
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function jobHistory(limit = 12): Promise<JobRow[]> {
  return db.jobs.orderBy('createdAt').reverse().limit(limit).toArray();
}

export async function clearJobHistory(): Promise<void> {
  await db.jobs.clear();
}
