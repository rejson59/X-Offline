import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { PostCard } from './PostCard';
import { Reel } from './Reel';
import { useSettings } from '@/lib/store';
import { markRead } from '@/lib/posts';
import { IconBook, IconClose, IconSearch, IconX } from './Icons';
import type { PostRecord } from '@/lib/types';

type Filter = 'all' | 'unread' | 'media';

const PAGE = 60;

export function FeedTab() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [reel, setReel] = useState<number | null>(null);
  const [visible, setVisible] = useState(PAGE);
  const setTab = useSettings((s) => s.setTab);
  const reelMode = useSettings((s) => s.settings.reelMode);

  const saved = useLiveQuery(() => db.posts.where('savedAt').above(0).reverse().sortBy('savedAt'), [], [] as PostRecord[]);
  const unreadCount = useMemo(() => saved.filter((p) => !p.readAt).length, [saved]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^[@#]/, '');
    return saved.filter((p) => {
      if (filter === 'unread' && p.readAt) return false;
      if (filter === 'media' && !p.media.length) return false;
      if (!needle) return true;
      return (
        p.text.toLowerCase().includes(needle) ||
        p.authorName.toLowerCase().includes(needle) ||
        p.authorHandle.toLowerCase().includes(needle) ||
        (p.tags ?? []).some((t) => t.replace(/^[@#]/, '').includes(needle))
      );
    });
  }, [saved, q, filter]);

  const page = useMemo(() => shown.slice(0, visible), [shown, visible]);

  function openReader(startId?: string): void {
    const index = startId ? shown.findIndex((p) => p.id === startId) : shown.findIndex((p) => !p.readAt);
    setReel(index >= 0 ? index : 0);
  }

  if (!saved.length) {
    return (
      <div className="empty fade-in">
        <span className="empty-mark" aria-hidden>
          <IconBook />
        </span>
        <h3>Tu będzie Twoja kolejka do czytania</h3>
        <p className="small dim">
          Otwórz X w podglądzie i przewiń trochę — posty zapiszą się same i wrócisz do nich bez internetu.
        </p>
        <button className="btn primary" onClick={() => setTab('x')}>
          <IconX /> Otwórz X
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="feed-tools">
        <div className="search">
          <IconSearch aria-hidden />
          <input
            className="search-input"
            placeholder="Szukaj…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setVisible(PAGE);
            }}
            aria-label="Szukaj w zapisanych"
          />
          {q ? (
            <button className="icon-btn xs" onClick={() => setQ('')} aria-label="Wyczyść szukanie">
              <IconClose />
            </button>
          ) : null}
        </div>
        <button className="btn small quiet" onClick={() => openReader()} disabled={!shown.length}>
          {unreadCount ? `Czytaj (${unreadCount})` : 'Czytaj'}
        </button>
      </div>

      <div className="chips calm" role="group" aria-label="Filtr">
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          Wszystko
        </button>
        <button className="chip" aria-pressed={filter === 'unread'} onClick={() => setFilter(filter === 'unread' ? 'all' : 'unread')}>
          Nieprzeczytane{unreadCount ? ` · ${unreadCount}` : ''}
        </button>
        <button className="chip" aria-pressed={filter === 'media'} onClick={() => setFilter(filter === 'media' ? 'all' : 'media')}>
          Z mediami
        </button>
        {unreadCount > 0 && filter === 'unread' ? (
          <button
            className="chip ghost"
            onClick={() => void markRead(shown.map((p) => p.id))}
          >
            Oznacz wszystkie jako przeczytane
          </button>
        ) : null}
      </div>

      {!shown.length ? (
        <div className="empty slim">
          <h3>Nic tu nie pasuje</h3>
          <p className="small dim">Zmień filtr albo wyczyść wyszukiwanie.</p>
        </div>
      ) : (
        <div className="feed-list">
          {page.map((post, i) => (
            <PostCard
              key={post.id}
              post={post}
              index={i}
              onOpen={
                reelMode
                  ? () => {
                      openReader(post.id);
                    }
                  : undefined
              }
            />
          ))}
          {shown.length > page.length ? (
            <div className="more-wrap">
              <button className="btn quiet" onClick={() => setVisible((v) => v + PAGE)}>
                Pokaż więcej ({shown.length - page.length})
              </button>
            </div>
          ) : null}
        </div>
      )}

      {reel !== null ? <Reel posts={shown} startIndex={reel} onClose={() => setReel(null)} /> : null}
    </>
  );
}
