/**
 * „Załaduj 200 następnych postów” bez wybierania czegokolwiek ręcznie.
 *
 * W APK i tak zbieramy wszystko, co mija Twój wzrok (patrz bridge.ts) — to jest ścieżka dla
 * trybu proxy/direct: kółko po realnych profilach z Twojej listy, jedna partia naraz,
 * aż uzbieramy tyle postów, ile ustawisz (albo aż skończą się świeże rzeczy / dobijemy do limitu).
 */
import { create } from 'zustand';
import { db } from '@/db/db';
import { fetchProfile } from './sources';
import { ingestPosts, followHandles, savedOfflineCount, noteCapture } from './capture';
import { estimateStorage } from './media';
import { fetchMissingMedia } from './posts';
import { useSettings } from './store';
import { bytesLabel } from './format';
import { logError } from './diagnostics';
import type { PostRecord } from './types';

type LogLine = { at: number; text: string; kind: 'info' | 'ok' | 'warn' | 'error' };

interface FillState {
  running: boolean;
  saved: number;
  target: number;
  round: number;
  bytes: number;
  log: LogLine[];
  error?: string;
  start: (target?: number) => Promise<void>;
  stop: () => void;
  reset: () => void;
}

let controller: AbortController | null = null;

const MAX_ROUNDS = 8;

export const useFill = create<FillState>((set, get) => ({
  running: false,
  saved: 0,
  target: 0,
  round: 0,
  bytes: 0,
  log: [],

  start: async (target) => {
    if (get().running) return;
    const settings = useSettings.getState().settings;
    const goal = Math.max(10, Math.min(1000, target ?? settings.autoTarget ?? 200));
    controller = new AbortController();
    const log = (text: string, kind: LogLine['kind'] = 'info') => {
      set({ log: [{ at: Date.now(), text, kind }, ...get().log].slice(0, 60) });
      if (kind === 'warn' || kind === 'error') noteCapture(text, 'warn');
    };

    set({ running: true, target: goal, round: 0, bytes: 0, error: undefined, saved: await savedOfflineCount() });
    log(`Start: cel ${goal} postów offline`);

    const accounts = await db.accounts.toArray();
    const handles = [...new Set([...followHandles(), ...accounts.map((a) => a.handle)])];
    if (!handles.length) {
      const message = 'Nie ma skąd czytać — dopisz profile w Ustawienia → Lista kont albo otwórz podgląd X w APK.';
      set({ running: false, error: message });
      log(message, 'warn');
      controller = null;
      return;
    }
    log(`Profile: ${handles.map((h) => `@${h}`).join(', ')}`);

    let saved = await savedOfflineCount();
    let bytes = 0;
    let emptyStreak = 0;
    let round = 0;

    try {
      while (saved < goal && round < MAX_ROUNDS && !controller.signal.aborted) {
        round++;
        set({ round });
        // Partia rośnie z rundą: najpierw świeże 25, potem głębsze porcje.
        const perProfile = Math.min(100, 25 + (round - 1) * 25);
        for (const h of handles) {
          if (saved >= goal || controller.signal.aborted) break;
          if (!useSettings.getState().online) {
            log('Łącze zniknęło — przerywam dociąganie.', 'warn');
            return;
          }
          const remaining = goal - saved;
          try {
            const res = await fetchProfile(h, Math.min(perProfile, Math.max(10, remaining)));
            if (!res.posts.length) {
              emptyStreak++;
              log(`@${h}: ${res.error ?? 'brak nowych postów'}${res.failure ? ` (${res.failure})` : ''}`, 'warn');
              continue;
            }
            const report = await ingestPosts(res.posts as PostRecord[], {
              via: 'fill',
              source: 'live-scroll',
              maxPosts: Math.max(5, remaining),
              origin: 'profile',
            });
            saved += report.saved;
            bytes += report.bytes;
            set({ saved, bytes });
            log(
              `@${h}: +${report.saved} postów${report.bytes ? ` · ${bytesLabel(report.bytes)}` : ''}${
                report.reason ? ` (${report.reason})` : ''
              }`,
              report.saved ? 'ok' : 'info',
            );
          } catch (err) {
            log(`@${h}: ${(err as Error).message}`, 'error');
            logError(`dociąganie @${h}`, err);
          }
          await new Promise((r) => setTimeout(r, 120));
        }

        if (emptyStreak >= handles.length * 2) {
          log('Nie ma już świeżych postów na tej liście — kończę.', 'warn');
          break;
        }

        // Nie dubeltujemy w limit miejsca.
        if (settings.storageCapMb) {
          const { usage } = await estimateStorage();
          if (usage > settings.storageCapMb * 1024 * 1024) {
            log('Limit miejsca osiągnięty — przystopowałem (ustaw wyżej albo wyłącz auto-czyszczenie).', 'warn');
            break;
          }
        }
      }
      log(saved >= goal ? `Gotowe: ${saved} postów offline` : `Zatrzymane przy ${saved}/${goal}`, saved >= goal ? 'ok' : 'warn');
      // Na koniec spróbuj dociągnąć to, co przy zapisie nie zdążyło (zdjęcia/klipy, słabe łącze).
      if (saved > 0) {
        const fixed = await fetchMissingMedia();
        if (fixed.posts) log(`Dociągnięte media do ${fixed.posts} postów (${bytesLabel(fixed.bytes)})`, 'ok');
      }
    } catch (err) {
      const message = String((err as Error).message ?? err);
      set({ error: message });
      log(message, 'error');
      logError('dociąganie offline', err);
    } finally {
      set({ running: false, saved: await savedOfflineCount() });
      controller = null;
      const { useQueue } = await import('./download');
      await useQueue.getState().refreshTotals().catch(() => undefined);
    }
  },

  stop: () => {
    controller?.abort();
    useFill.setState({ running: false });
  },

  reset: () => set({ log: [], bytes: 0, round: 0, error: undefined }),
}));

/** Czy przy starcie warto samo dokarmiać offline? */
export async function shouldAutoFillOnOpen(): Promise<boolean> {
  const { settings, online } = useSettings.getState();
  if (!online || !settings.autoCapture || !settings.autoSyncOnOpen) return false;
  const saved = await savedOfflineCount();
  return saved < settings.autoTarget * 0.8;
}
