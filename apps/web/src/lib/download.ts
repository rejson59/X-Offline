/**
 * Kolejka pobierania. Prosta, ale z tym, co ważne na słabym łączu:
 * postęp per zadanie, anulowanie, ograniczona równoległość, historia w IndexedDB.
 */
import { create } from 'zustand';
import { db } from '@/db/db';
import { fetchPostsByLinks, fetchProfile, sleep } from './sources';
import { saveOffline, upsertPosts, refreshAccountCounts } from './posts';
import { pruneToCap } from './media';
import { useSettings } from './store';
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
}

interface QueueState {
  tasks: Task[];
  running: boolean;
  savedCount: number;
  totalBytes: number;
  enqueueProfile: (handles: string[], count?: number) => Promise<number>;
  enqueueLinks: (links: string[]) => Promise<number>;
  cancel: (id: string) => void;
  cancelAll: () => void;
  clearFinished: () => void;
  refreshTotals: () => Promise<void>;
}

const controllers = new Map<string, AbortController>();
const uid = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

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
      const clean = [...new Set(handles.map((h) => h.trim().replace(/^@/, '')).filter(Boolean))];
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

    cancel: (id) => {
      controllers.get(id)?.abort();
      patchTask(id, { status: get().tasks.find((t) => t.id === id)?.status === 'running' ? 'cancelled' : 'cancelled' });
    },

    cancelAll: () => {
      controllers.forEach((c) => c.abort());
      set({
        tasks: get().tasks.map((t) =>
          t.status === 'queued' || t.status === 'running' ? { ...t, status: 'cancelled' } : t,
        ),
      });
    },

    clearFinished: () => set({ tasks: get().tasks.filter((t) => t.status === 'queued' || t.status === 'running') }),

    refreshTotals: async () => {
      const [count, bytes] = await Promise.all([
        db.posts.where('savedAt').above(0).count(),
        db.posts.where('savedAt').above(0).toArray().then((rows) => rows.reduce((sum, p) => sum + (p.sizeBytes ?? 0), 0)),
      ]);
      set({ savedCount: count, totalBytes: bytes });
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
      patchTask(task.id, { status: 'running', startedAt: Date.now(), errors: [] });

      let savedCount = 0;
      let bytes = 0;
      let failures: string[] = [];
      let fatal: string | undefined;

      try {
        const settings = useSettings.getState().settings;
        let posts: PostRecord[] = [];
        let upstream = 'demo';

        if (task.type === 'links' && task.payload?.links) {
          const res = await fetchPostsByLinks(task.payload.links, (done, total) => patchTask(task.id, { done, total }));
          posts = res.posts;
          upstream = res.upstream;
          fatal = res.posts.length ? undefined : res.error;
          if (res.hint && !res.posts.length) failures.push(res.hint);
        } else if (task.type === 'profile' && task.payload?.handle) {
          const res = await fetchProfile(task.payload.handle, task.total || 25);
          posts = res.posts;
          upstream = res.upstream;
          fatal = res.posts.length ? undefined : (res.error ?? 'Brak wyników');
          if (res.hint && !res.posts.length) failures.push(res.hint);
        }

        const saved = await upsertPosts(posts);
        savedCount = saved.length;
        patchTask(task.id, { done: saved.length, total: saved.length || task.total, upstream });

        // Media lecą równolegle, ale max 3 na raz — więcej i słabe łącze się dławi.
        let done = saved.length;
        await runPool(
          saved.filter((p) => !p.savedAt),
          Math.min(3, Math.max(1, saved.length)),
          async (post) => {
            if (controller.signal.aborted) return;
            try {
              const out = await saveOffline(post, controller.signal);
              bytes += out.bytes;
              failures = failures.concat(out.errors.map((e) => `${post.authorHandle}: ${e}`));
            } catch (err) {
              failures.push(`${post.authorHandle}: ${(err as Error).message}`);
            } finally {
              patchTask(task.id, { bytes, done: ++done });
            }
          },
        );

        if (settings.storageCapMb && settings.autoPrune) {
          await pruneToCap(settings.storageCapMb, settings.pruneKeepPosts);
        }
      } catch (err) {
        fatal = String((err as Error).message ?? err);
      } finally {
        controllers.delete(task.id);
      }

      await refreshAccountCounts();
      await useQueue.getState().refreshTotals();
      const status: TaskStatus = controller.signal.aborted ? 'cancelled' : fatal ? 'error' : 'done';
      patchTask(task.id, { status, bytes, errors: failures.slice(0, 5), finishedAt: Date.now(), done: savedCount });
      if (task.jobId) {
        const update: Partial<JobRow> = {
          status,
          done: savedCount,
          bytes,
          errors: failures.slice(0, 5),
          finishedAt: Date.now(),
        };
        if (fatal) update.lastError = fatal;
        await db.jobs.update(task.jobId, update);
      }
      await sleep(50);
    }
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
