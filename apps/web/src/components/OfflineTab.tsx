import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { PostCard } from './PostCard';
import { Reel } from './Reel';
import { bytesLabel, plural } from '@/lib/format';
import { useSettings } from '@/lib/store';
import {
  deletePosts,
  exportLibrary,
  exportMarkdown,
  fetchMissingMedia,
  markRead,
  unsavePosts,
} from '@/lib/posts';
import { useQueue } from '@/lib/download';
import { libraryFileName, saveTextFile } from '@/lib/native';
import { revokeAllObjectUrls } from '@/lib/media';
import { Sheet } from './Sheets';
import { IconBookmark, IconCheck, IconClose, IconDownload, IconRefresh, IconSearch, IconShare, IconTrash } from './Icons';
import type { PostRecord } from '@/lib/types';

type Chip = 'all' | 'unread' | 'media' | 'video' | 'text' | 'pending' | 'liked' | 'bookmarked' | 'queued';
type Sort = 'saved' | 'created' | 'author';

const CHIPS: [Chip, string][] = [
  ['all', 'Wszystko'],
  ['unread', 'Nieprzeczytane'],
  ['media', 'Z mediami'],
  ['pending', 'Media w chmurze'],
  ['video', 'Wideo/GIF'],
  ['text', 'Sam tekst'],
  ['liked', 'Polubione'],
  ['bookmarked', 'Zakładki X'],
  ['queued', 'Z kolejki akcji'],
];

const SORTS: [Sort, string][] = [
  ['saved', 'Ostatnio zapisane'],
  ['created', 'Najnowsze posty'],
  ['author', 'Po autorze'],
];

export function OfflineTab() {
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sort, setSort] = useState<Sort>('saved');
  const [handle, setHandle] = useState<string | null>(null);
  const [reel, setReel] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | 'clear'>(null);
  const settings = useSettings((s) => s.settings);
  const toast = useSettings((s) => s.toast);
  const savedCount = useQueue((s) => s.savedCount);

  const saved = useLiveQuery(() => db.posts.where('savedAt').above(0).reverse().sortBy('savedAt'), [], [] as PostRecord[]);
  // Kolejka akcji musi być policzona PRZED filtrowaniem — inaczej filtr „Z kolejki akcji”
  // sięgałby po zmienną, która jeszcze nie istnieje (to właśnie wywalało apkę).
  const queuedIds = useLiveQuery(
    async () => {
      const rows = await db.actions.where('status').anyOf('pending', 'sending', 'error').toArray();
      return new Set(rows.map((r) => r.postId));
    },
    [],
    new Set<string>(),
  );

  const handles = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of saved) m.set(p.authorHandle, (m.get(p.authorHandle) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [saved]);

  const unreadCount = useMemo(() => saved.filter((p) => !p.readAt).length, [saved]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^[@#]/, '');
    const filtered = saved.filter((p) => {
      if (handle && p.authorHandle !== handle) return false;
      if (chip === 'unread' && p.readAt) return false;
      if (chip === 'media' && !p.media.length) return false;
      if (chip === 'pending' && !p.media.some((m) => !m.cached)) return false;
      if (chip === 'video' && !p.media.some((m) => m.kind === 'video' || m.kind === 'gif')) return false;
      if (chip === 'text' && p.media.length) return false;
      if (chip === 'liked' && !p.xLiked) return false;
      if (chip === 'bookmarked' && !p.xBookmarked) return false;
      if (chip === 'queued' && !queuedIds.has(p.id)) return false;
      if (!needle) return true;
      return (
        p.text.toLowerCase().includes(needle) ||
        p.authorName.toLowerCase().includes(needle) ||
        p.authorHandle.toLowerCase().includes(needle) ||
        (p.tags ?? []).some((t) => t.replace(/^[@#]/, '').includes(needle))
      );
    });
    const sorted = [...filtered];
    if (sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt);
    else if (sort === 'author') sorted.sort((a, b) => a.authorHandle.localeCompare(b.authorHandle, 'pl') || b.createdAt - a.createdAt);
    else sorted.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
    return sorted;
  }, [saved, q, chip, handle, sort, queuedIds]);

  const capBytes = settings.storageCapMb * 1024 * 1024;
  const pendingCount = useMemo(() => shown.filter((p) => p.media.some((m) => !m.cached)).length, [shown]);
  const pickedPosts = useMemo(() => shown.filter((p) => picked.has(p.id)), [shown, picked]);

  function togglePick(post: PostRecord, next: boolean): void {
    setPicked((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(post.id);
      else copy.delete(post.id);
      return copy;
    });
  }

  function exitSelect(): void {
    setSelectMode(false);
    setPicked(new Set());
  }

  async function runBulk(kind: 'read' | 'unread' | 'unsave' | 'delete' | 'media'): Promise<void> {
    const ids = [...picked];
    if (!ids.length) return;
    setBusy(kind);
    try {
      if (kind === 'read') {
        await markRead(ids, true);
        toast(`Oznaczono jako przeczytane: ${ids.length}`, 'ok');
      } else if (kind === 'unread') {
        await markRead(ids, false);
        toast(`Z powrotem nieprzeczytane: ${ids.length}`, 'info');
      } else if (kind === 'unsave') {
        const freed = await unsavePosts(ids);
        await useQueue.getState().refreshTotals();
        toast(`Usunięto z offline ${ids.length} postów (${bytesLabel(freed)})`, 'info');
      } else if (kind === 'delete') {
        await deletePosts(ids);
        await useQueue.getState().refreshTotals();
        toast(`Skasowano trwale ${ids.length} postów`, 'warn');
      } else if (kind === 'media') {
        const out = await fetchMissingMedia(ids);
        await useQueue.getState().refreshTotals();
        toast(out.posts ? `Dociągnięto media do ${out.posts} postów (${bytesLabel(out.bytes)})` : 'Nie udało się dociągnąć mediów', out.posts ? 'ok' : 'warn');
      }
      exitSelect();
    } catch (err) {
      toast(`Nie wyszło: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  async function exportLib(): Promise<void> {
    const lib = await exportLibrary();
    if (!lib.posts.length) {
      toast('Nie ma czego eksportować — zapisz najpierw kilka postów', 'warn');
      return;
    }
    const res = await saveTextFile(libraryFileName(), JSON.stringify(lib, null, 2));
    toast(
      res.where === 'native' ?
        `Zapisano bibliotekę (${plural(lib.posts.length, 'post', 'posty', 'postów')}) — ${res.label ?? 'Documents'}`
      : `Wyeksportowano ${plural(lib.posts.length, 'post', 'posty', 'postów')} do pliku`,
      'ok',
    );
  }

  async function exportMd(): Promise<void> {
    const md = await exportMarkdown();
    if (!md.posts) {
      toast('Nie ma czego eksportować', 'warn');
      return;
    }
    const res = await saveTextFile(md.name, md.text, 'text/markdown');
    toast(res.where === 'native' ? `Zapisano ${md.name} — ${res.label ?? 'Documents'}` : `Wyeksportowano ${md.posts} postów do Markdown`, 'ok');
  }

  function openReader(startId?: string): void {
    const index = startId ? shown.findIndex((p) => p.id === startId) : shown.findIndex((p) => !p.readAt);
    setReel(index >= 0 ? index : 0);
    if (startId) void markRead([startId]);
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
              placeholder="Szukaj w zapisanych (tekst, @autor, #tag)…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {q ? (
            <button className="icon-btn" onClick={() => setQ('')} aria-label="Wyczyść szukanie">
              <IconClose />
            </button>
          ) : null}
          <button className="btn primary small" onClick={() => openReader()} disabled={!shown.length}>
            {unreadCount && chip !== 'unread' ? `Czytaj dalej (${unreadCount})` : 'Czytnik'}
          </button>
        </div>

        <div className="banner" style={{ marginTop: 12 }}>
          <IconBookmark style={{ width: 20, height: 20, flex: 'none', color: 'var(--ok)' }} />
          <div className="grow small">
            <b>{plural(saved.length, 'post', 'posty', 'postów')}</b> w pamięci · {bytesLabel(saved.reduce((s, p) => s + (p.sizeBytes ?? 0), 0))}
            {capBytes ? ` z ${bytesLabel(capBytes)}` : ''}
            {unreadCount ? <span className="badge info" style={{ marginLeft: 6 }}>{unreadCount} nieprzeczytane</span> : null}
            {pendingCount ? <span className="badge warn" style={{ marginLeft: 6 }}>{pendingCount} bez mediów</span> : null}
            {saved.length !== savedCount ? <span className="tiny dim"> (licznik: {savedCount})</span> : null}
            <div className="meter" style={{ marginTop: 8 }} aria-hidden>
              <i
                style={{
                  width: capBytes ?
                    `${Math.min(100, Math.round((saved.reduce((s, p) => s + (p.sizeBytes ?? 0), 0) / capBytes) * 100))}%`
                  : '0%',
                }}
              />
            </div>
          </div>
          <div className="row tight">
            <button className="icon-btn" onClick={() => void exportLib()} aria-label="Eksport .json" title="Eksport biblioteki (.json)">
              <IconShare />
            </button>
            <button className="icon-btn" onClick={() => void exportMd()} aria-label="Eksport Markdown" title="Eksport czytelny (.md)">
              <IconDownload />
            </button>
            <button
              className="icon-btn"
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              aria-label={selectMode ? 'Zakończ wybieranie' : 'Wybierz wiele'}
              title={selectMode ? 'Zakończ wybieranie' : 'Wybierz wiele postów'}
              style={selectMode ? { color: 'var(--accent)' } : undefined}
            >
              <IconCheck />
            </button>
          </div>
        </div>

        {saved.some((p) => p.media.some((m) => !m.cached)) ? (
          <button
            className="btn ghost small"
            style={{ marginTop: 8 }}
            disabled={busy === 'media'}
            onClick={async () => {
              setBusy('media');
              try {
                const out = await fetchMissingMedia();
                await useQueue.getState().refreshTotals();
                toast(out.posts ? `Dociągnięto media do ${out.posts} postów (${bytesLabel(out.bytes)})` : 'Wszystko, co się dało, jest już w pamięci', out.posts ? 'ok' : 'info');
              } finally {
                setBusy(null);
              }
            }}
          >
            <IconRefresh /> {busy === 'media' ? 'Dociągam media…' : 'Dociągnij brakujące media'}
          </button>
        ) : null}
      </div>

      <div className="chips">
        {CHIPS.map(([id, label]) => (
          <button key={id} className="chip" aria-pressed={chip === id} onClick={() => setChip(chip === id ? 'all' : id)}>
            {label}
            {id === 'unread' && unreadCount ? ` · ${unreadCount}` : ''}
          </button>
        ))}
        {handles.map(([h, n]) => (
          <button key={h} className="chip" aria-pressed={handle === h} onClick={() => setHandle(handle === h ? null : h)}>
            @{h} · {n}
          </button>
        ))}
      </div>

      <div className="chips" style={{ paddingTop: 0, borderBottom: '1px solid var(--line-soft)' }}>
        {SORTS.map(([id, label]) => (
          <button key={id} className="chip" aria-pressed={sort === id} onClick={() => setSort(id)}>
            {label}
          </button>
        ))}
        {chip !== 'all' || handle || q ? <span className="tiny dim" style={{ alignSelf: 'center' }}>filtr: {shown.length}/{saved.length}</span> : null}
      </div>

      {selectMode ? (
        <div className="section" style={{ paddingTop: 8, paddingBottom: 0 }}>
          <div className="banner info" style={{ marginTop: 0, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
            <div className="row small">
              <span className="grow">
                Zaznaczone: <b>{picked.size}</b> — stuknij kafelki, żeby wybrać.
              </span>
              <button
                className="btn ghost small"
                onClick={() => setPicked(new Set(shown.map((p) => p.id)))}
                disabled={!shown.length}
              >
                Zaznacz widoczne ({shown.length})
              </button>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn ghost small" disabled={!picked.size || busy !== null} onClick={() => void runBulk('read')}>
                <IconCheck /> Przeczytane
              </button>
              <button className="btn ghost small" disabled={!picked.size || busy !== null} onClick={() => void runBulk('unread')}>
                Nieprzeczytane
              </button>
              <button className="btn ghost small" disabled={!picked.size || busy !== null} onClick={() => void runBulk('media')}>
                <IconRefresh /> Media
              </button>
              <button className="btn ghost small" disabled={!picked.size || busy !== null} onClick={() => void runBulk('unsave')}>
                Usuń z offline
              </button>
              <button className="btn danger small" disabled={!picked.size || busy !== null} onClick={() => setSheet('clear')}>
                <IconTrash /> Skasuj trwale
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!shown.length ? (
        <div className="empty">
          <IconDownload />
          <h3>{saved.length ? 'Nic tu nie pasuje do filtra' : 'Nie masz jeszcze nic zapisanego'}</h3>
          <p className="small">
            {saved.length ?
              'Zmień filtr, sortowanie albo wyczyść wyszukiwanie.'
            : 'Wejdź w „Na żywo”: dodaj profil i kliknij pobieranie, wklej linki do postów albo otwórz X w podglądzie (APK zbiera to, co przewiniesz).'}
          </p>
        </div>
      ) : (
        shown.map((post, i) => (
          <PostCard
            key={post.id}
            post={post}
            showStats={false}
            selectable={selectMode}
            selected={picked.has(post.id)}
            onSelect={togglePick}
            onOpen={() => {
              void markRead([post.id]);
              setReel(i);
            }}
          />
        ))
      )}

      {reel !== null ? (
        <Reel
          posts={shown}
          startIndex={reel}
          onClose={() => {
            setReel(null);
            void useQueue.getState().refreshTotals();
          }}
        />
      ) : null}

      {sheet === 'clear' ? (
        <Sheet
          title={`Skasować trwale ${pickedPosts.length} postów?`}
          subtitle="Znikną z pamięci razem z mediami — tego nie da się cofnąć."
          onClose={() => setSheet(null)}
          footer={
            <div className="row">
              <button className="btn ghost grow" onClick={() => setSheet(null)}>
                <IconClose /> Zostaw
              </button>
              <button
                className="btn danger grow"
                onClick={async () => {
                  setSheet(null);
                  revokeAllObjectUrls();
                  await runBulk('delete');
                }}
              >
                <IconTrash /> Skasuj
              </button>
            </div>
          }
        >
          <p className="small dim">
            Skasowane posty znikają z offline. Zapis w samym X (polubienie/zakładka) zostaje nietknięty — jeśli chcesz go
            usunąć, zrób to w X albo użyj kolejki akcji.
          </p>
        </Sheet>
      ) : null}
    </>
  );
}
