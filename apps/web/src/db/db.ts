import Dexie, { type Table } from 'dexie';
import type { AccountRow, ActionRow, BlobRow, JobRow, PostRecord, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';

export interface MetaRow {
  key: string;
  value: unknown;
}

class XOfflineDB extends Dexie {
  posts!: Table<PostRecord, string>;
  blobs!: Table<BlobRow, string>;
  accounts!: Table<AccountRow, string>;
  jobs!: Table<JobRow, number>;
  meta!: Table<MetaRow, string>;
  actions!: Table<ActionRow, number>;

  constructor() {
    super('x-offline');
    this.version(1).stores({
      // savedAt jest indeksem — posty bez tej wartości nie trafiają do indeksu (to nasz filtr offline).
      posts: '&id, nativeId, authorHandle, createdAt, savedAt, source, *tags',
      blobs: '&key, postId, url, createdAt',
      accounts: '&handle, lastSyncAt',
      jobs: '++id, status, createdAt',
      meta: '&key',
    });
    // v2: kolejka akcji do odtworzenia w X (polubienia / zakładki) + licznik błędów przy postach.
    this.version(2).stores({
      actions: '++id, status, kind, tweetId, createdAt, sentAt',
    });
    // v3: koniec z danymi demo. Doszedł stan „przeczytane” (readAt) i kolejka zdarzeń diagnostycznych.
    // Migracja czyści to, co poprzednie wersje wrzuciły same z siebie (posty demo, konta demo).
    this.version(3)
      .stores({
        posts: '&id, nativeId, authorHandle, createdAt, savedAt, readAt, source, origin, *tags',
        blobs: '&key, postId, url, createdAt',
        accounts: '&handle, lastSyncAt',
        jobs: '++id, status, createdAt',
        meta: '&key',
        actions: '++id, status, kind, tweetId, createdAt, sentAt',
      })
      .upgrade(async (tx) => {
        const posts = tx.table<PostRecord, string>('posts');
        const accounts = tx.table<AccountRow, string>('accounts');
        const meta = tx.table<MetaRow, string>('meta');

        // 1) Posty z zestawu demo (i ewentualne inne wpisy bez realnego pochodzenia).
        const demoPosts = await posts.filter((p) => (p as { source?: string }).source === 'demo').toArray();
        for (const post of demoPosts) await posts.delete(post.id);

        // 2) Konta, które istniały tylko po to, żeby demo miało „profile”.
        const rows = await accounts.toArray();
        for (const acc of rows) {
          if (acc.lastStatus === 'demo' || /^demo:/i.test(acc.handle)) await accounts.delete(acc.handle);
        }

        // 3) Ustawienia: tryb „tylko demo” nie ma już sensu → wracamy do `auto`.
        const settingsRow = await meta.get('settings');
        if (settingsRow?.value && typeof settingsRow.value === 'object') {
          const value = settingsRow.value as Record<string, unknown>;
          if (value.sourceMode === 'demo') value.sourceMode = 'auto';
          const follow = typeof value.followList === 'string' ? value.followList : '';
          if (/kasia_koduje|silesia_dev|orbita_pl|foto_wegierek|low_bitrate|x_offline/.test(follow)) {
            value.followList = '';
          }
          await meta.put({ key: 'settings', value });
        }
        await meta.delete('welcomeSeeded');
      });
    // v4: tylko WebView. Czyścimy listę śledzonych profili i historię zadań pobierania
    // (API/proxy nie istnieje — posty przychodzą wyłącznie z podglądu X) oraz
    // przestarzałe klucze ustawień. Zapisane posty i media zostają nietknięte.
    this.version(4)
      .stores({
        posts: '&id, nativeId, authorHandle, createdAt, savedAt, readAt, source, origin, *tags',
        blobs: '&key, postId, url, createdAt',
        accounts: '&handle, lastSyncAt',
        jobs: '++id, status, createdAt',
        meta: '&key',
        actions: '++id, status, kind, tweetId, createdAt, sentAt',
      })
      .upgrade(async (tx) => {
        await tx.table('accounts').clear();
        await tx.table('jobs').clear();
        const meta = tx.table<MetaRow, string>('meta');
        const settingsRow = await meta.get('settings');
        if (settingsRow?.value && typeof settingsRow.value === 'object') {
          const value = settingsRow.value as Record<string, unknown>;
          for (const key of [
            'sourceMode',
            'proxyUrl',
            'liveFrameTemplate',
            'followList',
            'autoSyncOnOpen',
            'mirrorToBookmarks',
            'replayActions',
            'mediaOnWifiOnly',
            'trimOverTarget',
            'pruneKeepPosts',
            'scrollBatch',
          ]) {
            delete value[key];
          }
          await meta.put({ key: 'settings', value });
        }
        await meta.delete('firstRunTip');
      });
  }
}

export const db = new XOfflineDB();

/** Czy baza w ogóle wystartowała? (tryb prywatny / zablokowane IndexedDB potrafią ją wyłożyć). */
export async function dbReady(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await db.open();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export async function loadSettings(): Promise<Settings> {
  const row = await db.meta.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await db.meta.put({ key: 'settings', value: settings });
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  return (row?.value as T) ?? fallback;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Rozmiar bazy w bajtach (teksty + media) — liczone bez sięgania do `navigator.storage`. */
export async function localBytes(): Promise<number> {
  const blobs = await db.blobs.toArray();
  return blobs.reduce((sum, b) => sum + (b.bytes ?? 0), 0);
}
