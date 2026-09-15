import { useEffect, useRef, useState } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import { fullTime } from '@/lib/format';
import { markRead, unsavePosts } from '@/lib/posts';
import { pushBackHandler } from '@/lib/native';
import { useSettings } from '@/lib/store';
import type { PostRecord } from '@/lib/types';
import { renderText } from './PostCard';
import { toggleBookmark, toggleLike } from '@/lib/actions';
import { IconBookmarkFilled, IconClose, IconExternal, IconHeartFilled, IconQueue, IconShare } from './Icons';

function ReelItem({
  post,
  active,
  onClose,
}: {
  post: PostRecord;
  active: boolean;
  onClose: () => void;
}) {
  const media = post.media[0];
  const resolved = useResolvedMedia(media);
  const [playing, setPlaying] = useState(false);
  const toast = useSettings((s) => s.toast);
  const markReadOnOpen = useSettings((s) => s.settings.markReadOnOpen);

  useEffect(() => {
    if (!active || !markReadOnOpen || !post.savedAt || post.readAt) return;
    void markRead([post.id]);
  }, [active, markReadOnOpen, post.id, post.savedAt, post.readAt]);

  async function act(kind: 'like' | 'bookmark') {
    if (kind === 'like') await toggleLike(post);
    else await toggleBookmark(post);
  }

  const portrait = Boolean(media?.width && media?.height && media.height > media.width);
  const bgStyle = media
    ? {
        backgroundImage: `url(${media.kind === 'video' ? (media.poster ?? (resolved.local ? resolved.src : '')) : resolved.src})`,
      }
    : undefined;

  async function share() {
    const payload = `${post.text}\n\n— @${post.authorHandle}${post.url ? `\n${post.url}` : ''}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: `@${post.authorHandle}`, text: payload, url: post.url });
        return;
      } catch {
        /* użytkownik zamknął udostępnianie */
      }
    }
    try {
      await navigator.clipboard.writeText(payload);
      toast('Skopiowano treść posta', 'ok');
    } catch {
      toast('Nie da się skopiować w tym miejscu', 'error');
    }
  }

  return (
    <section className="reel-item" aria-hidden={!active}>
      {media && media.kind !== 'video' ? <div className={portrait ? 'bg' : 'bg cover'} style={bgStyle} /> : null}
      {media && media.kind === 'video' && active && !playing ? (
        <div className="bg cover" style={media.poster ? { backgroundImage: `url(${media.poster})` } : undefined} />
      ) : null}
      {media && media.kind === 'video' && active && playing ? (
        <video src={resolved.src} poster={media.poster} controls autoPlay playsInline onEnded={() => setPlaying(false)} />
      ) : null}

      <div className="reel-top">
        <button className="icon-btn" onClick={onClose} aria-label="Zamknij czytnik">
          <IconClose />
        </button>
        <div className="grow reel-author">
          <b>{post.authorName}</b>
          <span className="dim">@{post.authorHandle}</span>
        </div>
        {post.media.length > 1 ? <span className="pill">+{post.media.length - 1}</span> : null}
      </div>

      <div className="reel-meta">
        {media && media.kind === 'video' && !playing ? (
          <button className="btn primary small" onClick={() => setPlaying(true)} style={{ marginBottom: 10 }}>
            Odtwórz klip
          </button>
        ) : null}

        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div className="grow">
            <p className="post-text" style={{ marginTop: 0 }}>
              {renderText(post.text)}
            </p>
            <div className="tiny dim" style={{ marginTop: 8 }}>
              {fullTime(post.createdAt)} · {post.stats.likes.toLocaleString('pl-PL')} polubień
            </div>
          </div>
          <div className="reel-rail">
            <button className="icon-btn" onClick={share} aria-label="Udostępnij">
              <IconShare />
            </button>
            {post.url ? (
              <a className="icon-btn" href={post.url} target="_blank" rel="noreferrer" aria-label="Otwórz w X">
                <IconExternal />
              </a>
            ) : null}
            <button
              className="icon-btn"
              aria-label={post.xLiked ? 'Cofnij polubienie' : 'Polub'}
              style={post.xLiked ? { color: 'var(--like)' } : undefined}
              onClick={() => void act('like')}
            >
              <IconHeartFilled />
            </button>
            <button
              className="icon-btn"
              aria-label={post.xBookmarked ? 'Usuń z zakładek' : 'Dodaj do zakładek'}
              style={post.xBookmarked ? { color: 'var(--accent)' } : undefined}
              onClick={() => void act('bookmark')}
            >
              <IconBookmarkFilled />
            </button>
            {post.savedAt ? (
              <button
                className="icon-btn"
                aria-label="Usuń z offline"
                onClick={async () => {
                  await unsavePosts([post.id]);
                  toast('Usunięto z offline', 'info');
                }}
              >
                <IconQueue />
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Pionowy czytnik zapisanych postów. Renderuje tylko okno wokół aktywnego posta,
 * żeby lista 500 zapisów nie dławiła telefonu.
 */
export function Reel({
  posts,
  startIndex = 0,
  onClose,
}: {
  posts: PostRecord[];
  startIndex?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(startIndex);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = startIndex * el.clientHeight;
    setIndex(startIndex);
  }, [startIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') el.scrollTop += el.clientHeight;
      if (e.key === 'ArrowUp') el.scrollTop -= el.clientHeight;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const release = pushBackHandler(() => {
      onClose();
      return true;
    });
    return () => {
      document.body.style.overflow = '';
      release();
    };
  }, [onClose]);

  if (!posts.length) return null;

  const lo = Math.max(0, index - 1);
  const hi = Math.min(posts.length, index + 3);

  return (
    <div className="reel" role="dialog" aria-modal="true" aria-label="Czytnik">
      <div
        className="reel-scroll"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const next = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
          if (next !== index) setIndex(Math.max(0, Math.min(posts.length - 1, next)));
        }}
      >
        {lo > 0 ? <div style={{ height: `${lo * 100}dvh`, flex: 'none' }} aria-hidden /> : null}
        {posts.slice(lo, hi).map((post, k) => (
          <ReelItem key={post.id} post={post} active={lo + k === index} onClose={onClose} />
        ))}
        {hi < posts.length ? <div style={{ height: `${(posts.length - hi) * 100}dvh`, flex: 'none' }} aria-hidden /> : null}
      </div>
      <div className="reel-counter">
        <span>
          {index + 1} / {posts.length}
        </span>
      </div>
    </div>
  );
}
