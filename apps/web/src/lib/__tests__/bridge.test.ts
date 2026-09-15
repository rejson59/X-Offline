import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ścieżka APK: zdarzenia z natywnego podglądu X → baza.
 *
 * To jest najważniejszy kontrakt w całym projekcie — jeśli coś go zepsuje, użytkownik
 * przewija X i „nic się nie zapisuje”. Dlatego podszywamy się pod wtyczkę natywną
 * (`Capacitor.Plugins.XLive`) i sprawdzamy, że realne tweety z GraphQL faktycznie
 * lądują w bazie jako zapisane offline.
 */
const native = vi.hoisted(() => ({ plugins: {} as Record<string, unknown> }));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    get Plugins() {
      return native.plugins;
    },
  },
  CapacitorHttp: { get: vi.fn() },
}));

import { db } from '@/db/db';
import { bridge } from '@/lib/bridge';
import { captureEvents } from '@/lib/capture';
import { useSettings } from '@/lib/store';
import { graphqlTweet, mockNetwork } from './helpers';
import type { ActionRow } from '@/lib/types';

type Emit = (name: string, payload: unknown) => void;

function fakePlugin() {
  const listeners = new Map<string, (event: unknown) => void>();
  const removed: string[] = [];
  const plugin = {
    listeners,
    removed,
    open: vi.fn(async () => ({ ok: true, url: 'https://x.com/home' })),
    close: vi.fn(async () => ({ ok: true })),
    status: vi.fn(async () => ({ open: true, captured: 7, target: 200, loggedIn: true, scrolling: false })),
    replay: vi.fn(async () => ({ queued: 1 })),
    consumeSharedIntent: vi.fn(async () => ({ url: 'https://x.com/orbita_pl/status/1234567890' })),
    addListener: vi.fn(async (name: string, fn: (event: unknown) => void) => {
      listeners.set(name, fn);
      return { remove: () => removed.push(name) };
    }),
    emit: ((name, payload) => listeners.get(name)?.({ payload })) as Emit,
  };
  return plugin;
}

let plugin: ReturnType<typeof fakePlugin>;
/** Mostek trzyma stan w module — po każdym teście odpinamy listenery, żeby testy się nie kłóciły. */
let detach: (() => void) | null = null;

beforeEach(async () => {
  await db.posts.clear();
  await db.blobs.clear();
  await db.accounts.clear();
  await db.actions.clear();
  await db.jobs.clear();
  mockNetwork();
  useSettings.setState({
    online: true,
    settings: {
      ...useSettings.getState().settings,
      autoCapture: true,
      autoTarget: 50,
      mirrorBookmarks: true,
      storageCapMb: 0,
      persistStorage: false,
    },
  });
  plugin = fakePlugin();
  native.plugins = { XLive: plugin };
});

afterEach(() => {
  detach?.();
  detach = null;
});

describe('mostek z natywnym podglądem X (APK)', () => {
  it('zapisuje posty wyłapane przy przewijaniu — z autorem, treścią i znacznikiem offline', async () => {
    detach = await bridge.startCapturing();
    expect(plugin.listeners.has('tweetsCaptured')).toBe(true);

    plugin.emit('tweetsCaptured', { source: 'live-scroll', tweets: [graphqlTweet()] });

    await vi.waitFor(async () => expect(await db.posts.count()).toBe(1), { timeout: 5000 });
    const post = (await db.posts.toArray())[0];
    expect(post.authorHandle).toBe('orbita_pl');
    expect(post.text).toContain('GraphQL post');
    expect(post.savedAt).toBeGreaterThan(0);
    expect(post.via).toBe('auto-scroll');
    expect(post.origin).toBe('live');
    expect(captureEvents().length).toBeGreaterThan(0);
  });

  it('post z zakładek X wchodzi ponad limit celu i jest oznaczony jako lustrzany', async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, autoTarget: 1 } });
    detach = await bridge.startCapturing();

    plugin.emit('tweetsCaptured', { source: 'bookmarks-mirror', tweets: [graphqlTweet(), graphqlTweet()] });

    await vi.waitFor(async () => expect(await db.posts.where('savedAt').above(0).count()).toBe(2), { timeout: 5000 });
    const rows = await db.posts.where('savedAt').above(0).toArray();
    expect(rows.every((r) => r.via === 'bookmarks-mirror' && r.origin === 'mirror')).toBe(true);
  });

  it('surowe śmieci z podsłuchu nie wywalają niczego', async () => {
    detach = await bridge.startCapturing();
    plugin.emit('tweetsCaptured', { source: 'live-scroll', tweets: [{ hello: 'to nie tweet' }, null, 42] });
    plugin.emit('tweetsCaptured', 'nieprawidłowy kształt');

    await new Promise((r) => setTimeout(r, 50));
    expect(await db.posts.count()).toBe(0);
  });

  it('wynik klikań z X zamyka akcje w kolejce', async () => {
    const row: ActionRow = {
      kind: 'like',
      tweetId: '8000000000000000001',
      postId: 'syndication:8000000000000000001',
      authorHandle: 'orbita_pl',
      status: 'sending',
      attempts: 1,
      createdAt: Date.now(),
      origin: 'offline-reader',
    };
    const id = (await db.actions.add(row)) as number;

    detach = await bridge.startCapturing();
    plugin.emit('actionsDone', { results: [{ id, ok: true }] });

    await vi.waitFor(async () => expect((await db.actions.get(id))?.status).toBe('sent'), { timeout: 5000 });
  });

  it('stan podglądu i otwieranie idą przez wtyczkę', async () => {
    await expect(bridge.openLive({ tab: 'bookmarks', maxPosts: 50 })).resolves.toEqual({ ok: true });
    expect(plugin.open).toHaveBeenCalledWith({ capture: true, tab: 'bookmarks', maxPosts: 50 });

    const status = await bridge.status();
    expect(status.open).toBe(true);
    expect(status.captured).toBe(7);
    expect(status.loggedIn).toBe(true);
  });

  it('link udostępniony z innego miejsca Androida trafia do nas', async () => {
    const seen: Array<{ url?: string; text?: string }> = [];
    await bridge.startShareListener((shared) => seen.push(shared));

    expect(seen[0]?.url).toContain('/status/');
    plugin.emit('shareReceived', { text: 'zobacz to https://x.com/orbita_pl/status/99' });
    expect(seen[1]?.text).toContain('/status/99');
  });

  it('odpięcie listenerów zwalnia miejsce (koniec zbierania)', async () => {
    const off = await bridge.startCapturing();
    off();
    expect(plugin.removed).toContain('tweetsCaptured');

    // Po odpięciu zbieranie można włączyć od nowa — tym razem na świeżej wtyczce.
    const fresh = fakePlugin();
    native.plugins = { XLive: fresh };
    detach = await bridge.startCapturing();
    expect(fresh.listeners.has('tweetsCaptured')).toBe(true);
  });
});
