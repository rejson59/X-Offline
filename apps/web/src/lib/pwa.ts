/** Instalacja PWA + aktualizacje service workera, z jednym punktem wejścia dla App. */
import { create } from 'zustand';
import { Capacitor } from '@capacitor/core';

interface PwaState {
  offlineReady: boolean;
  needRefresh: boolean;
  canInstall: boolean;
  installed: boolean;
  updateSW: ((reloadPage?: boolean) => Promise<void>) | null;
  deferred: BeforeInstallPromptEvent | null;
  init: () => Promise<void>;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export const usePwa = create<PwaState>((set, get) => ({
  offlineReady: false,
  needRefresh: false,
  canInstall: false,
  installed: false,
  updateSW: null,
  deferred: null,

  init: async () => {
    if (typeof window === 'undefined') return;
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      Capacitor.isNativePlatform();
    set({ installed: Boolean(standalone) });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      set({ deferred: e as BeforeInstallPromptEvent, canInstall: true });
    });
    window.addEventListener('appinstalled', () => set({ installed: true, canInstall: false, deferred: null }));

    if (Capacitor.isNativePlatform()) return; // APK ma własny mechanizm aktualizacji
    try {
      const mod = await import('virtual:pwa-register');
      const updateSW = mod.registerSW({
        immediate: true,
        onOfflineReady() {
          set({ offlineReady: true });
        },
        onNeedRefresh() {
          set({ needRefresh: true });
        },
      });
      set({ updateSW });
    } catch {
      /* service worker niedostępny (np. http:// bez localhost) */
    }
  },

  install: async () => {
    const deferred = get().deferred;
    if (!deferred) return 'unavailable';
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    set({ deferred: null, canInstall: outcome !== 'accepted' });
    return outcome;
  },
}));
