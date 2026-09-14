import { useEffect, useRef, useState } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import { bytesLabel, fullTime, relativeTime } from '@/lib/format';
import { unsavePosts } from '@/lib/posts';
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

  async function act(kind: 'like' | 'bookmark') {
    const out = kind === 'like' ? await toggleLike(post) : await toggleBookmark(post);
    toast(
      `${kind === 'like' ? 'Polubienie' : 'Zakładka'}: ${out.kind.startsWith('un') ? 'cofnięte' : 'dodane'} — w kolejce do X`,
      'info',
    );
  }

  const portrait = Boolean(media?.width && media?.height && media.height > media.width);
  const bgStyle = media ?
    {
      backgroundImage: `url(${media.kind === 'video' ? (media.poster ?? (resolved.local ? resolved.src : '')) : resolved.src})`,
    }
  : undefined;

  async function share() {
    const payload = `${post.text}\n\n— @${post.authorHandle}, X-Offline${post.url ? `\n${post.url}` : ''}`;
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
      toast('Nie da się skopiować w tym kontekście', 'error');
    }
  }

  return (
    <section className="reel-item" aria-hidden={!active}>
      {media && media.kind !== 'video' ? <div className={portrait ? 'bg' : 'bg cover'} style={bgStyle} /> : null}
      {media && media.kind === 'video' && active && playing ? (
        <video src={resolved.src} poster={media.poster} controls autoPlay playsInline onEnded={() => setPlaying(false)} />
      ) : null}

      <div className="reel-top">
        <button className="icon-btn" onClick={onClose} aria-label="Zamknij czytnik">
          <IconClose />
        </button>
        <div className="grow row tight wrap">
          <b>{post.authorName}</b>
          <span className="dim small">@{post.authorHandle}</span>
          {post.savedAt ? <span className="badge ok">offline</span> : <span className="badge">niezapisane</span>}
          {media && !resolved.local && media.kind !== 'video' ? <span className="badge warn">brak pliku</span> : null}
        </div>
        <div className="grow" />
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
            <div className="row wrap tiny dim" style={{ marginTop: 8 }}>
              <span>{fullTime(post.createdAt)}</span>
              <span>·</span>
              <span>{post.stats.likes.toLocaleString('pl-PL')} polubień</span>
              {post.sizeBytes ? (
                <>
                  <span>·</span>
                  <span>{bytesLabel(post.sizeBytes)} w pamięci</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="row tight" style={{ flexDirection: 'column' }}>
            <button className="icon-btn" onClick={share} aria-label="Udostępnij">
              <IconShare />
            </button>
            {post.url ? (
              <a className="icon-btn" href={post.url} target="_blank" rel="noreferrer" aria-label="Otwórz w X">
                <IconExternal />
              </a>
            ) : null}
            <button
              className={`icon-btn${post.xLiked ? ' liked' : ''}`}
              aria-label={post.xLiked ? 'Cofnij polubienie' : 'Polub (wyślemy później)'}
              style={post.xLiked ? { color: 'var(--like)' } : undefined}
              onClick={() => void act('like')}
            >
              <IconHeartFilled />
            </button>
            <button
              className="icon-btn"
              aria-label={post.xBookmarked ? 'Usuń z zakładek X' : 'Dodaj do zakładek X'}
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
                  const freed = await unsavePosts([post.id]);
                  toast(`Usunięto z offline (${bytesLabel(freed)})`, 'info');
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

/** Pionowy czytnik „jak TikTok” dla zapisanych postów. Swipe/snap = natywne zachowanie przeglądarki. */
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

  return (
    <div className="reel" role="dialog" aria-modal="true" aria-label="Czytnik offline">
      <div
        className="reel-scroll"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const next = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
          if (next !== index) setIndex(Math.max(0, Math.min(posts.length - 1, next)));
        }}
      >
        {posts.map((post, i) => (
          <ReelItem key={post.id} post={post} active={i === index} onClose={onClose} />
        ))}
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div className="row tight" style={{ background: 'rgba(0,0,0,.5)', borderRadius: 999, padding: '5px 10px' }}>
          <span className="tiny dim">
            {index + 1} / {posts.length} · swipe lub ↑↓
          </span>
          <span className="reel-dots">
            {posts.slice(Math.max(0, index - 3), Math.min(posts.length, index + 4)).map((p, i) => (
              <i key={p.id} className={Math.max(0, index - 3) + i === index ? 'on' : ''} />
            ))}
          </span>
          <span className="tiny dim">{relativeTime(posts[index]?.createdAt ?? Date.now())}</span>
        </div>
      </div>
    </div>
  );
}
