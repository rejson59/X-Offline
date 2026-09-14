import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { PostCard } from './PostCard';
import { Reel } from './Reel';
import { bytesLabel, plural } from '@/lib/format';
import { useSettings } from '@/lib/store';
import { exportLibrary } from '@/lib/posts';
import { useQueue } from '@/lib/download';
import { libraryFileName, saveTextFile } from '@/lib/native';
import { IconBookmark, IconDownload, IconSearch, IconShare } from './Icons';
import type { PostRecord } from '@/lib/types';

type Chip = 'all' | 'media' | 'video' | 'text';

export function OfflineTab() {
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [handle, setHandle] = useState<string | null>(null);
  const [reel, setReel] = useState<number | null>(null);
  const settings = useSettings((s) => s.settings);
  const toast = useSettings((s) => s.toast);
  const savedCount = useQueue((s) => s.savedCount);

  const saved = useLiveQuery(() => db.posts.where('savedAt').above(0).reverse().sortBy('savedAt'), [], [] as PostRecord[]);

  const handles = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of saved) m.set(p.authorHandle, (m.get(p.authorHandle) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [saved]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return saved.filter((p) => {
      if (handle && p.authorHandle !== handle) return false;
      if (chip === 'media' && !p.media.length) return false;
      if (chip === 'video' && !p.media.some((m) => m.kind === 'video' || m.kind === 'gif')) return false;
      if (chip === 'text' && p.media.length) return false;
      if (!needle) return true;
      return (
        p.text.toLowerCase().includes(needle) ||
        p.authorName.toLowerCase().includes(needle) ||
        p.authorHandle.toLowerCase().includes(needle) ||
        (p.tags ?? []).some((t) => t.includes(needle.replace(/^[@#]/, '')))
      );
    });
  }, [saved, q, chip, handle]);

  const bytes = useMemo(() => shown.reduce((s, p) => s + (p.sizeBytes ?? 0), 0), [shown]);
  const capBytes = settings.storageCapMb * 1024 * 1024;

  async function exportLib() {
    const lib = await exportLibrary();
    if (!lib.posts.length) {
      toast('Nie ma czego eksportować — zapisz najpierw kilka postów', 'warn');
      return;
    }
    const name = libraryFileName();
    const res = await saveTextFile(name, JSON.stringify(lib, null, 2));
    toast(
      res.where === 'native' ?
        `Zapisano ${plural(lib.posts.length, 'plik', 'pliki', 'plików')} w Documents: ${res.path}`
      : `Wyeksportowano ${plural(lib.posts.length, 'post', 'posty', 'postów')} do pliku`,
      'ok',
    );
  }

  return (
    <>
      <div className="section" style={{ paddingTop: 12, paddingBottom: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <div className="grow" style={{ position: 'relative' }}>
            <IconSearch style={{ position: 'absolute', left: 10, top: 11, width: 18, height: 18, color: 'var(--text-dim)' }} />
            <input
              className="field"
              style={{ paddingLeft: 36 }}
              placeholder="Szukaj w zapisanych…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button className="btn primary small" onClick={() => setReel(0)} disabled={!shown.length}>
            Czytnik
          </button>
        </div>

        <div className="banner" style={{ marginTop: 12 }}>
          <IconBookmark style={{ width: 20, height: 20, flex: 'none', color: 'var(--ok)' }} />
          <div className="grow small">
            <b>{plural(saved.length, 'post', 'posty', 'postów')}</b> w pamięci urządzenia · {bytesLabel(bytes)}
            {capBytes ? ` z ${bytesLabel(capBytes)}` : ''}
            {saved.length !== savedCount ? <span className="tiny dim"> (licznik: {savedCount})</span> : null}
            <div className="meter" style={{ marginTop: 8 }} aria-hidden>
              <i style={{ width: capBytes ? `${Math.min(100, Math.round((bytes / capBytes) * 100))}%` : '0%' }} />
            </div>
            <div className="tiny dim" style={{ marginTop: 6 }}>
              Wszystko poniżej czyta się bez żadnego zasięgu — treść i media są w IndexedDB.
            </div>
          </div>
          <button className="icon-btn" onClick={exportLib} aria-label="Wyeksportuj bibliotekę" title="Eksport do pliku .json">
            <IconShare />
          </button>
        </div>
      </div>

      <div className="chips">
        {(
          [
            ['all', 'Wszystko'],
            ['media', 'Z mediami'],
            ['video', 'Wideo/GIF'],
            ['text', 'Sam tekst'],
          ] as [Chip, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className="chip"
            aria-pressed={chip === id}
            onClick={() => setChip(chip === id ? 'all' : id)}
          >
            {label}
          </button>
        ))}
        {handles.map(([h, n]) => (
          <button key={h} className="chip" aria-pressed={handle === h} onClick={() => setHandle(handle === h ? null : h)}>
            @{h} · {n}
          </button>
        ))}
      </div>

      {!shown.length ? (
        <div className="empty">
          <IconDownload />
          <h3>{saved.length ? 'Nic tu nie pasuje do filtra' : 'Nie masz jeszcze nic zapisanego'}</h3>
          <p className="small">
            {saved.length ?
              'Zmień filtr albo wyczyść wyszukiwanie.' :
              'Wejdź w „Na żywo” → pobierz profil, albo kliknij zakładkę przy dowolnym poście.'}
          </p>
        </div>
      ) : (
        shown.map((post, i) => (
          <PostCard key={post.id} post={post} showStats={false} onOpen={() => setReel(i)} />
        ))
      )}

      {reel !== null ? <Reel posts={shown} startIndex={reel} onClose={() => setReel(null)} /> : null}
    </>
  );
}
