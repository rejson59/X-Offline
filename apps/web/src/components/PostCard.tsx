import { memo, useState, type ReactNode } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import { avatarColor, bytesLabel, compact, initials, relativeTime, segmentText } from '@/lib/format';
import { saveOffline, unsavePosts, fetchMissingMedia, markRead } from '@/lib/posts';
import { toggleBookmark, toggleLike } from '@/lib/actions';
import { useSettings } from '@/lib/store';
import type { PostRecord } from '@/lib/types';
import { MediaGrid } from './MediaGrid';
import {
  IconBookmark,
  IconBookmarkFilled,
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
  const showImg = post.authorAvatar && src && !failed;
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

function PostCardInner({
  post,
  index = 0,
  onOpen,
}: {
  post: PostRecord;
  index?: number;
  onOpen?: (post: PostRecord) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [actBusy, setActBusy] = useState<'like' | 'bookmark' | null>(null);
  const toast = useSettings((s) => s.toast);
  const markReadOnOpen = useSettings((s) => s.settings.markReadOnOpen);
  const saved = Boolean(post.savedAt);
  const unread = saved && !post.readAt;
  const missingMedia = post.media.length > 0 && post.media.some((m) => !m.cached);

  async function act(kind: 'like' | 'bookmark', e: React.MouseEvent) {
    e.stopPropagation();
    if (actBusy) return;
    setActBusy(kind);
    try {
      if (kind === 'like') await toggleLike(post);
      else await toggleBookmark(post);
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
        toast(freed ? `Usunięto z offline (${bytesLabel(freed)})` : 'Usunięto z offline', 'info');
      } else {
        await saveOffline(post);
        toast('Zapisano', 'ok');
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
      toast(out.posts ? 'Media dociągnięte' : 'Nie udało się — spróbuj później', out.posts ? 'ok' : 'warn');
    } finally {
      setMediaBusy(false);
    }
  }

  return (
    <article
      className="post enter"
      style={{ ['--i' as string]: Math.min(index, 12) }}
      onClick={
        onOpen
          ? () => {
              if (markReadOnOpen && saved && !post.readAt) void markRead([post.id]);
              onOpen(post);
            }
          : undefined
      }
    >
      <header className="post-head">
        <Avatar post={post} />
        <div className="post-names">
          <div className="row1">
            <span className="name">{post.authorName}</span>
            {unread ? <span className="dot-new" title="Nieprzeczytane" /> : null}
          </div>
          <div className="row2">
            <span className="handle">@{post.authorHandle}</span>
            <span aria-hidden>·</span>
            <span className="handle">{relativeTime(post.createdAt)}</span>
          </div>
        </div>
      </header>

      {post.text ? <p className="post-text">{renderText(post.text)}</p> : null}

      {post.media.length > 0 && <MediaGrid items={post.media} onOpen={() => onOpen?.(post)} />}

      {post.card ? (
        <a className="card-link" href={post.card.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          {post.card.image ? <div className="img" style={{ backgroundImage: `url(${post.card.image})` }} /> : null}
          <div className="txt">
            <b>{post.card.title}</b>
            <span>{post.card.domain}</span>
          </div>
        </a>
      ) : null}

      <footer className="post-actions">
        <span className="action static" title="Odpowiedzi">
          <IconReply /> {post.stats.replies ? compact(post.stats.replies) : ''}
        </span>
        <span className="action static" title="Podbicia">
          <IconRepost /> {post.stats.reposts ? compact(post.stats.reposts) : ''}
        </span>
        <button
          type="button"
          className={`action like${post.xLiked ? ' on' : ''}${actBusy === 'like' ? ' busy' : ''}`}
          onClick={(e) => void act('like', e)}
          title={post.xLiked ? 'Cofnij polubienie' : 'Polub'}
          aria-pressed={post.xLiked}
        >
          {actBusy === 'like' ? <IconSpinner /> : post.xLiked ? <IconHeartFilled /> : <IconHeart />}
          {post.stats.likes ? compact(post.stats.likes) : ''}
        </button>
        <button
          type="button"
          className={`action mark${post.xBookmarked ? ' on' : ''}${actBusy === 'bookmark' ? ' busy' : ''}`}
          onClick={(e) => void act('bookmark', e)}
          title={post.xBookmarked ? 'Usuń z zakładek' : 'Dodaj do zakładek'}
          aria-pressed={post.xBookmarked}
        >
          {actBusy === 'bookmark' ? <IconSpinner /> : post.xBookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
        </button>
        {missingMedia && saved ? (
          <button
            type="button"
            className={`action faint${mediaBusy ? ' busy' : ''}`}
            onClick={retryMedia}
            title="Dociągnij media"
            aria-label="Dociągnij brakujące media"
          >
            {mediaBusy ? <IconSpinner /> : <IconRefresh />}
          </button>
        ) : null}
        <span className="spacer" />
        <button
          type="button"
          className={`action save${saved ? ' on' : ''}${busy ? ' busy' : ''}`}
          onClick={toggle}
          title={saved ? 'Usuń z offline' : 'Zapisz do offline'}
          aria-pressed={saved}
        >
          {busy ? <IconSpinner /> : <IconCloud />}
        </button>
      </footer>
    </article>
  );
}

export const PostCard = memo(PostCardInner);
