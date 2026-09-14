/** Hook dla UI: żywy podgląd planu akcji + licznik. */
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { ActionRow } from './types';

export function useActionList(): { rows: ActionRow[]; stats: { pending: number; sent: number; error: number } } {
  const rows = useLiveQuery(() => db.actions.orderBy('createdAt').reverse().limit(50).toArray(), [], [] as ActionRow[]);
  const stats = {
    pending: rows.filter((r) => r.status === 'pending' || r.status === 'sending').length,
    sent: rows.filter((r) => r.status === 'sent').length,
    error: rows.filter((r) => r.status === 'error').length,
  };
  return { rows, stats };
}
