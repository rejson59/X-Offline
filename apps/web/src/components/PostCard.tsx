import { useEffect, useState, type ReactNode } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import { avatarColor, bytesLabel, initials, relativeTime, segmentText } from '@/lib/format';
import { saveOffline, unsavePosts } from '@/lib/posts';
import { hasPendingFor, toggleBookmark, toggleLike } from '@/lib/actions';
import { plural } from '@/lib/format';
import { useSettings } from '@/lib/store';
import type { PostRecord } from '@/lib/types';
import { MediaGrid } from './MediaGrid';
import {
  IconBookmark,
  IconBookmarkFilled,
  IconCloud,
  IconHeart,
  IconHeartFilled,
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
}: {
  post: PostRecord;
  onOpen?: (post: PostRecord) => void;
  showStats?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [actBusy, setActBusy] = useState<'like' | 'bookmark' | null>(null);
  const [queued, setQueued] = useState(false);
  const toast = useSettings((s) => s.toast);
  const saved = Boolean(post.savedAt);

  useEffect(() => {
    void hasPendingFor(post.id).then((row) => setQueued(Boolean(row)));
  }, [post.xLiked, post.xBookmarked, post.id, actBusy]);

  async function act(kind: 'like' | 'bookmark') {
    if (actBusy) return;
    setActBusy(kind);
    try {
      const out = kind === 'like' ? await toggleLike(post) : await toggleBookmark(post);
      const label = kind === 'like' ? (out.kind === 'like' ? 'Polubienie' : 'Cofnięte polubienie') : out.kind === 'bookmark' ? 'Zakładka' : 'Usunięta zakładka';
      toast(`${label} — w kolejce do wysłania, gdy będzie łącze`, 'info');
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
          toast(`Treść zapisana, media nie (proxy/CORS). ${out.errors[0]?.slice(0, 80)}`, 'warn');
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

  return (
    <article
      className={`post${saved ? ' is-saved' : ''}`}
      onClick={onOpen ? () => onOpen(post) : undefined}
      style={onOpen ? { cursor: 'pointer' } : undefined}
    >
      <header className="post-head">
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
          {saved ? <span className="badge ok">offline</span> : post.source === 'demo' ? <span className="badge">demo</span> : null}
        </div>
      </header>

      {post.text ? <p className="post-text">{renderText(post.text)}</p> : null}

      {post.media.length > 0 && <MediaGrid items={post.media} onOpen={() => onOpen?.(post)} />}

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
        <button
          type="button"
          className={`action save${saved ? ' saved' : ''}${busy ? ' busy' : ''}`}
          onClick={toggle}
          title={saved ? 'Usuń z offline' : 'Zapisz do czytania bez internetu'}
        >
          {busy ? <IconSpinner /> : <IconCloud />}
          <span className="tiny">{busy ? 'zapisywanie…' : saved ? 'offline' : 'offline'}</span>
          {queued ? <span className="pill" style={{ padding: '1px 6px' }}>w kolejce</span> : null}
        </button>
      </footer>
    </article>
  );
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}tys`;
  return `${(n / 1000000).toFixed(1)}mln`;
}
