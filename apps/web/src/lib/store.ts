import { create } from 'zustand';
import { DEFAULT_SETTINGS, type Settings } from './types';
import { loadSettings, saveSettings } from '@/db/db';
import { logError } from './diagnostics';

export type TabId = 'home' | 'live' | 'offline' | 'settings';

interface UiState {
  settings: Settings;
  hydrated: boolean;
  tab: TabId;
  online: boolean;
  /** 'slow' | 'ok' | 'offline' — heurystyka do badge'a w nagłówku. */
  link: 'offline' | 'slow' | 'ok';
  netInfo: { downlink?: number; effectiveType?: string; saveData?: boolean; rtt?: number };
  toasts: { id: number; text: string; kind: 'info' | 'ok' | 'warn' | 'error' }[];
  hydrate: () => Promise<void>;
  patch: (partial: Partial<Settings>) => void;
  setTab: (tab: TabId) => void;
  toast: (text: string, kind?: 'info' | 'ok' | 'warn' | 'error') => void;
  dropToast: (id: number) => void;
  refreshNet: () => void;
}

let saveTimer: number | undefined;

function flushSettings(): void {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  void saveSettings(useSettings.getState().settings).catch((err) => logError('zapis ustawień', err));
}

export const useSettings = create<UiState>((set, get) => ({
  settings: { ...DEFAULT_SETTINGS },
  hydrated: false,
  tab: 'home',
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  link: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'ok',
  netInfo: {},
  toasts: [],

  hydrate: async () => {
    let stored: Settings = { ...DEFAULT_SETTINGS };
    try {
      stored = await loadSettings();
    } catch (err) {
      logError('odczyt ustawień', err);
    }
    const envProxy = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_XOFFLE_PROXY ?? '';
    const settings = { ...DEFAULT_SETTINGS, ...stored, proxyUrl: stored.proxyUrl || envProxy };
    set({ settings, hydrated: true });
    get().refreshNet();
  },

  patch: (partial) => {
    const settings = { ...get().settings, ...partial };
    set({ settings });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void saveSettings(settings).catch((err) => logError('zapis ustawień', err));
    }, 250);
  },

  setTab: (tab) => set({ tab }),

  toast: (text, kind = 'info') => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    set({ toasts: [...get().toasts, { id, text, kind }] });
    window.setTimeout(() => get().dropToast(id), 4200);
  },

  dropToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  refreshNet: () => {
    const nav = navigator as Navigator & {
      connection?: { downlink?: number; effectiveType?: string; saveData?: boolean; rtt?: number };
    };
    const c = nav.connection;
    const online = nav.onLine;
    const slow = !c ? false : c.effectiveType ? /2g|3g/.test(c.effectiveType) : (c.downlink ?? 99) < 1.2;
    set({
      online,
      netInfo: { downlink: c?.downlink, effectiveType: c?.effectiveType, saveData: c?.saveData, rtt: c?.rtt },
      link: !online ? 'offline' : slow ? 'slow' : 'ok',
    });
  },
}));

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => useSettings.getState().refreshNet());
  window.addEventListener('offline', () => useSettings.getState().refreshNet());
  // Debounce ustawień mógł jeszcze nie wystrzelić (np. użytkownik zamknął apkę) — dociągamy na wyjściu.
  window.addEventListener('pagehide', flushSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSettings();
  });
}

export function shouldSkipMedia(): boolean {
  const { settings, netInfo, online } = useSettings.getState();
  if (!online) return true;
  return settings.respectSaveData && netInfo.saveData === true;
}

/** Czy w tym łączu wolno ruszać z pobieraniem (oszczędzanie danych, tryb offline)? */
export function canFetchNow(): boolean {
  const { online } = useSettings.getState();
  return online;
}
