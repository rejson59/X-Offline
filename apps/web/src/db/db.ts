import Dexie, { type Table } from 'dexie';
import type { AccountRow, ActionRow, BlobRow, JobRow, PostRecord, Settings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';

interface MetaRow {
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
  }
}

export const db = new XOfflineDB();

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
