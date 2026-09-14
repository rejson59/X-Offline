/**
 * Mostek z natywnym podglądem X (APK).
 *
 * W aplikacji natywnej dodaliśmy `XLivePlugin` + `XLiveActivity`: pełnoekranowy WebView
 * na prawdziwym x.com z Twoimi ciasteczkami, plus wstrzyknięty skrypt, który:
 *   - podsłuchuje odpowiedzi `x.com/i/api/graphql/*` i wysyła je do nas jako surowe tweety,
 *   - przewija feed, żeby zebrać partię postów (auto-scroll),
 *   - odtwarza zaległe polubienia / zakładki, gdy jest łącze.
 * W przeglądarce plugin nie istnieje → wszystkie metody grzecznie mówią „niedostępne”,
 * a apka zostaje przy trybie proxy/demo.
 */
import { Capacitor } from '@capacitor/core';
import type { ActionRow } from './types';
import type { ReplayResult } from './actions';
import { ingestTweets } from './capture';

export type LiveTab = 'home' | 'bookmarks' | 'profile' | 'search';

/** Stan podglądu X (to, co zwraca natywny `XLive.status()`). */
export interface LiveStatus {
  open: boolean;
  /** Ile postów wstrzyknięty skrypt zebrał do tej pory. */
  captured?: number;
  target?: number;
  loggedIn?: boolean;
  enabled?: boolean;
  scrolling?: boolean;
  info?: string;
  url?: string;
}

export interface OpenLiveOptions {
  tab?: LiveTab;
  handle?: string;
  query?: string;
  autoScroll?: boolean;
  /** Ile postów zebrać przed zatrzymaniem przewijania. */
  maxPosts?: number;
  /** Zbierać automatycznie (podsłuch graphql) — domyślnie true. */
  capture?: boolean;
}

interface XLivePlugin {
  open(opts: OpenLiveOptions): Promise<{ ok: boolean; url?: string }>;
  close(): Promise<{ ok: boolean }>;
  status(): Promise<LiveStatus>;
  replay(actions: unknown[]): Promise<{ queued?: number; raw?: string }>;
  addListener(eventName: string, listenerFunc: (event: unknown) => void): Promise<{ remove: () => void }>;
}

function plugin(): XLivePlugin | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;
  const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins;
  return plugins?.XLive as XLivePlugin | undefined;
}

let capturing = false;

export const bridge = {
  available(): boolean {
    return Boolean(plugin());
  },

  async openLive(opts: OpenLiveOptions = {}): Promise<{ ok: boolean; error?: string }> {
    const p = plugin();
    if (!p) return { ok: false, error: 'Podgląd na żywo z logowaniem jest w wersji natywnej (APK).' };
    try {
      await p.open({ capture: true, ...opts });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  },

  async closeLive(): Promise<void> {
    await plugin()?.close().catch(() => undefined);
  },

  async status() {
    const p = plugin();
    if (!p) return { open: false, loggedIn: false, captured: 0 };
    try {
      return await p.status();
    } catch {
      return { open: false, loggedIn: false, captured: 0 };
    }
  },

  /**
   * Wrzuca akcje do kliknięcia w prawdziwym UI X. Wyniki wracają eventem `actionsDone`
   * (stamtąd `reportResults`), więc tu zwracamy tylko ile poszło.
   */
  async replayActions(actions: ActionRow[]): Promise<{ queued: number }> {
    const p = plugin();
    if (!p) throw new Error('brak natywnego mostka');
    const out = await p.replay(
      actions.map((a) => ({ id: a.id as number, kind: a.kind, tweetId: a.tweetId, tweetUrl: a.tweetUrl ?? '' })),
    );
    return { queued: out?.queued ?? actions.length };
  },

  /** Nasłuchuje strumienia tweetów z WebView i wrzuca je do offline (polityka w capture.ts). */
  async startCapturing(): Promise<() => void> {
    const p = plugin();
    if (!p || capturing) return () => undefined;
    capturing = true;
    const handle = (event: unknown) => {
      const e = event as { payload?: Record<string, unknown> };
      const data = (e.payload ?? e) as { source?: string; tweets?: unknown };
      const mirror = data.source === 'bookmarks-mirror';
      void ingestTweets(data, {
        via: mirror ? 'bookmarks-mirror' : 'auto-scroll',
        source: mirror ? 'bookmarks-mirror' : 'live-scroll',
      });
    };
    const a = await p.addListener('tweetsCaptured', handle);
    const b = await p.addListener('actionsDone', (event) => {
      void (async () => {
        const { reportResults } = await import('./actions');
        // Natywny mostek owija każdą payloadkę w { payload: ... } — musimy ją odwinąć.
        const wrapped = event as { payload?: unknown; results?: ReplayResult[] };
        const e = (wrapped.payload ?? wrapped) as { results?: ReplayResult[] };
        if (e.results?.length) await reportResults(e.results);
      })();
    });
    return () => {
      capturing = false;
      a.remove();
      b.remove();
    };
  },

  /**
   * Ręczne wrzucenie surowego JSON-u (devtools w przeglądarce, testy, import z kopii zapasowej):
   *   await window.__xoffline.ingest(JSON.stringify(payload))
   */
  installDevHook(): void {
    if (typeof window === 'undefined') return;
    const w = window as Window & { __xoffline?: Record<string, unknown> };
    w.__xoffline = {
      ingest: async (payload: unknown) => {
        const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
        return await ingestTweets(parsed, { via: 'import', force: true });
      },
      bridge: this,
    };
  },
};
