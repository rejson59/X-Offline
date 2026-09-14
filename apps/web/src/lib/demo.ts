import demo from '@/fixtures/demo-posts.json';
import { db } from '@/db/db';
import type { AccountRow, PostRecord } from './types';

interface DemoFile {
  generatedAt: string;
  accounts: { handle: string; name: string; description: string; followers: number }[];
  posts: PostRecord[];
}

const data = demo as unknown as DemoFile;

export const demoAccounts = data.accounts;

/** Wkłada zestaw demo do bazy, jeśli jest pusto. Zawsze działa bez sieci. */
export async function ensureDemoSeeded(force = false): Promise<number> {
  const count = await db.posts.count();
  if (count > 0 && !force) return 0;
  const posts = data.posts.map((p) => ({ ...p, savedAt: null }));
  await db.posts.bulkPut(posts);
  await db.accounts.bulkPut(
    data.accounts.map<AccountRow>((a) => ({
      handle: a.handle,
      name: a.name,
      description: a.description,
      followers: a.followers,
      lastSyncAt: null,
      autoSync: false,
      savedCount: 0,
      fetchCount: 20,
      lastStatus: 'demo',
    })),
  );
  return posts.length;
}

export async function resetDemo(): Promise<number> {
  await db.blobs.clear();
  await db.posts.clear();
  await db.accounts.clear();
  return ensureDemoSeeded(true);
}

export function demoPostsFor(handle: string, count: number): PostRecord[] {
  return data.posts
    .filter((p) => p.authorHandle.toLowerCase() === handle.toLowerCase())
    .slice(0, count)
    .map((p) => ({ ...p }));
}

export const demoGeneratedAt = data.generatedAt;
