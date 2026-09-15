import { useState } from 'react';
import { useResolvedMedia } from '@/hooks/useResolvedMedia';
import type { MediaItem } from '@/lib/types';
import { IconPlay } from './Icons';

function MediaCell({ item, onOpen }: { item: MediaItem; onOpen?: () => void }) {
  const { src } = useResolvedMedia(item);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  return (
    <button type="button" className="media-cell" onClick={onOpen} aria-label="Otwórz media" tabIndex={onOpen ? 0 : -1}>
      {item.kind === 'video' && playing ? (
        <video
          src={src}
          poster={item.poster}
          controls
          autoPlay
          playsInline
          style={{ pointerEvents: 'auto' }}
          onPause={() => setPlaying(false)}
        />
      ) : item.kind === 'video' ? (
        <>
          <img
            src={item.poster ?? src}
            alt={item.alt ?? ''}
            loading="lazy"
            className={loaded ? 'is-loaded' : ''}
            onLoad={() => setLoaded(true)}
          />
          <span className="play" aria-hidden>
            <span>
              <IconPlay />
            </span>
          </span>
          {item.durationMs ? <span className="pill dur">{Math.round(item.durationMs / 1000)}s</span> : null}
        </>
      ) : (
        <img
          src={src}
          alt={item.alt ?? ''}
          loading="lazy"
          className={loaded ? 'is-loaded' : ''}
          onLoad={() => setLoaded(true)}
        />
      )}
    </button>
  );
}

export function MediaGrid({ items, onOpen }: { items: MediaItem[]; onOpen?: (index: number) => void }) {
  if (!items.length) return null;
  return (
    <div className={`media count-${Math.min(4, items.length)}`}>
      {items.slice(0, 4).map((item, i) => (
        <MediaCell key={item.url + i} item={item} onOpen={() => onOpen?.(i)} />
      ))}
    </div>
  );
}
