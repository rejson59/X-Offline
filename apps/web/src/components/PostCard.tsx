import { useEffect, useState, type ReactNode } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import { avatarColor, bytesLabel, compact, initials, plural, relativeTime, segmentText } from '@/lib/format';
import { saveOffline, unsavePosts, fetchMissingMedia, markRead } from '@/lib/posts';
import { hasPendingFor, toggleBookmark, toggleLike } from '@/lib/actions';
import { useSettings } from '@/lib/store';
import type { PostRecord } from '@/lib/types';
import { MediaGrid } from './MediaGrid';
import {
  IconBookmark,
  IconBookmarkFilled,
  IconCheck,
  IconCloud,
  IconHeart,
  IconHeartFilled,
  IconRefresh,
  IconReply,
  IconRepost,
  IconSpinner,
} from './Icons';

function Avatar({ post }: { post: PostRecord }) {
  const { src } = useResolvedMedia(post.authorAvatar ? { kind: 'image', url: post.authorAvatar } : undefined);
  const [failed, setFailed] = useState(false);
  const showImg = post.authorAvatar && src && !failed && (post.savedAt || navigator.onLine);
  return (
    <span className="avatar" style={{ background: avatarColor(post.authorHandle) }}>
      {showImg ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials(post.authorName)}
    </span>
  );
}

export function renderText(text: string): ReactNode[] {
  return segmentText(text).map((seg, i) => {
    if (seg.kind === 'link') {
      return (
        <a key={i} href={seg.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {seg.value.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </a>
      );
    }
    if (seg.kind === 'tag') {
      return (
        <span key={i} className="tag">
          {seg.value}
        </span>
      );
    }
    return <span key={i}>{seg.value}</span>;
  });
}

export function PostCard({
  post,
  onOpen,
  showStats = true,
  selectable = false,
  selected = false,
  onSelect,
}: {
  post: PostRecord;
  onOpen?: (post: PostRecord) => void;
  showStats?: boolean;
  /** Tryb zbiorczego wybierania (zaznaczanie kafelków do akcji). */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (post: PostRecord, next: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [actBusy, setActBusy] = useState<'like' | 'bookmark' | null>(null);
  const [queued, setQueued] = useState(false);
  const toast = useSettings((s) => s.toast);
  const saved = Boolean(post.savedAt);
  const unread = saved && !post.readAt;
  const missingMedia = saved && post.media.length > 0 && post.media.some((m) => !m.cached);

  useEffect(() => {
    void hasPendingFor(post.id).then((row) => setQueued(Boolean(row)));
  }, [post.xLiked, post.xBookmarked, post.id, actBusy]);

  async function act(kind: 'like' | 'bookmark') {
    if (actBusy) return;
    setActBusy(kind);
    try {
      const out = kind === 'like' ? await toggleLike(post) : await toggleBookmark(post);
      const label =
        kind === 'like' ? (out.kind === 'like' ? 'Polubienie' : 'Cofnięte polubienie')
        : out.kind === 'bookmark' ? 'Zakładka'
        : 'Usunięta zakładka';
      toast(`${label} — poleci do X, gdy będzie łącze`, 'info');
      setQueued(true);
    } catch (err) {
      toast(`Nie udało się: ${(err as Error).message}`, 'error');
    } finally {
      setActBusy(null);
    }
  }

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      if (saved) {
        const freed = await unsavePosts([post.id]);
        toast(`Usunięto z offline (${bytesLabel(freed)} zwolnione)`, 'info');
      } else {
        const out = await saveOffline(post);
        if (out.cached > 0) {
          toast(`Zapisano offline · ${plural(out.cached, 'plik', 'pliki', 'plików')} (${bytesLabel(out.bytes)})`, 'ok');
        } else if (out.errors.length) {
          toast(`Treść zapisana, media nie (${out.pendingMedia} do dociągnięcia). ${out.errors[0]?.slice(0, 70)}`, 'warn');
        } else {
          toast('Zapisano offline (post bez mediów)', 'ok');
        }
      }
    } catch (err) {
      toast(`Nie udało się zapisać: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function retryMedia(e: React.MouseEvent) {
    e.stopPropagation();
    if (mediaBusy) return;
    setMediaBusy(true);
    try {
      const out = await fetchMissingMedia([post.id]);
      if (out.posts) toast(`Dociągnięto media (${bytesLabel(out.bytes)})`, 'ok');
      else toast('Nie udało się dociągnąć mediów — spróbuj na innym łączu', 'warn');
    } finally {
      setMediaBusy(false);
    }
  }

  return (
    <article
      className={`post${saved ? ' is-saved' : ''}${unread ? ' is-new' : ''}${selected ? ' is-selected' : ''}`}
      onClick={
        selectable ?
          () => onSelect?.(post, !selected)
        : onOpen ?
          () => {
            if (useSettings.getState().settings.markReadOnOpen && saved && !post.readAt) void markRead([post.id]);
            onOpen(post);
          }
        : undefined
      }
      style={onOpen || selectable ? { cursor: 'pointer' } : undefined}
    >
      <header className="post-head">
        {selectable ? (
          <span className={`picker${selected ? ' on' : ''}`} aria-hidden>
            {selected ? <IconCheck /> : null}
          </span>
        ) : null}
        <Avatar post={post} />
        <div className="post-names">
          <div className="row1">
            <span>{post.authorName}</span>
            <span className="handle">@{post.authorHandle}</span>
            <span className="dim"> · </span>
            <span className="handle">{relativeTime(post.createdAt)}</span>
          </div>
        </div>
        <div className="row tight">
          {unread ? <span className="badge info">nowy</span> : null}
          {saved ? <span className="badge ok">offline</span> : null}
          {missingMedia ? <span className="badge warn">media w chmurze</span> : null}
        </div>
      </header>

      {post.text ? <p className="post-text">{renderText(post.text)}</p> : null}

      {post.media.length > 0 && <MediaGrid items={post.media} onOpen={() => (selectable ? onSelect?.(post, !selected) : onOpen?.(post))} />}

      {post.card ? (
        <a
          className="card-link"
          href={post.card.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {post.card.image ? <div className="img" style={{ backgroundImage: `url(${post.card.image})` }} /> : null}
          <div className="txt">
            <b>{post.card.title}</b>
            <span>{post.card.domain}</span>
            {post.card.brief ? <span className="dim">{post.card.brief}</span> : null}
          </div>
        </a>
      ) : null}

      <footer className="post-actions">
        <span className="action" title="Odpowiedzi">
          <IconReply /> {showStats && post.stats.replies ? compact(post.stats.replies) : ''}
        </span>
        <span className="action" title="Podbicia">
          <IconRepost /> {showStats && post.stats.reposts ? compact(post.stats.reposts) : ''}
        </span>
        <button
          type="button"
          className={`action like${post.xLiked ? ' on' : ''}${actBusy === 'like' ? ' busy' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            void act('like');
          }}
          title={post.xLiked ? 'Cofnij polubienie' : 'Polub (wyślemy, gdy będzie łącze)'}
        >
          {actBusy === 'like' ? <IconSpinner /> : post.xLiked ? <IconHeartFilled /> : <IconHeart />}
          {showStats && post.stats.likes ? compact(post.stats.likes) : ''}
        </button>
        <button
          type="button"
          className={`action like${post.xBookmarked ? ' on' : ''}${actBusy === 'bookmark' ? ' busy' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            void act('bookmark');
          }}
          title={post.xBookmarked ? 'Usuń z zakładek X' : 'Dodaj do zakładek X (i do offline)'}
        >
          {actBusy === 'bookmark' ? <IconSpinner /> : post.xBookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
        </button>
        {missingMedia ? (
          <button type="button" className={`action${mediaBusy ? ' busy' : ''}`} onClick={retryMedia} title="Dociągnij brakujące media">
            {mediaBusy ? <IconSpinner /> : <IconRefresh />}
          </button>
        ) : null}
        <button
          type="button"
          className={`action save${saved ? ' saved' : ''}${busy ? ' busy' : ''}`}
          onClick={toggle}
          title={saved ? 'Usuń z offline' : 'Zapisz do czytania bez internetu'}
        >
          {busy ? <IconSpinner /> : <IconCloud />}
          <span className="tiny">{busy ? 'zapisywanie…' : saved ? 'usuń' : 'offline'}</span>
          {queued ? <span className="pill" style={{ padding: '1px 6px' }}>w kolejce</span> : null}
        </button>
      </footer>
    </article>
  );
}
