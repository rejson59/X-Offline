import { useEffect, useState } from 'react';
import { db } from '@/db/db';
import { blobKey, objectUrlFor } from '@/lib/media';
import type { MediaItem } from '@/lib/types';

export interface ResolvedMedia {
  src: string;
  /** true = z IndexedDB (działa bez sieci), false = zdalne (service worker i tak ma CacheFirst). */
  local: boolean;
  loading: boolean;
}

/** Rozwiązuje URL media do lokalnego bloba, jeśli jest w cache'u. */
export function useResolvedMedia(item: MediaItem | undefined): ResolvedMedia {
  const [state, setState] = useState<ResolvedMedia>({ src: item?.url ?? '', local: false, loading: true });

  useEffect(() => {
    let alive = true;
    if (!item) {
      setState({ src: '', local: false, loading: false });
      return;
    }
    if (item.url.startsWith('/') || item.url.startsWith('data:') || item.url.startsWith('blob:')) {
      setState({ src: item.url, local: true, loading: false });
      return;
    }
    setState({ src: item.url, local: false, loading: true });
    void (async () => {
      const row = await db.blobs.get(blobKey(item.url));
      if (!alive) return;
      if (row) setState({ src: objectUrlFor(row.key, row.blob), local: true, loading: false });
      else setState({ src: item.url, local: false, loading: false });
    })();
    return () => {
      alive = false;
    };
  }, [item?.url, item?.cached, item?.poster]);

  return state;
}
