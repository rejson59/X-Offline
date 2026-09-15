import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { PostCard } from './PostCard';
import { Reel } from './Reel';
import { useSettings } from '@/lib/store';
import { useQueue } from '@/lib/download';
import { probeProxy } from '@/lib/transport';
import { bytesLabel, plural } from '@/lib/format';
import { markRead } from '@/lib/posts';
import type { PostRecord } from '@/lib/types';
import { IconCloud, IconDownload, IconRefresh, IconWifiOff } from './Icons';

type Filter = 'all' | 'media' | 'saved' | 'unread';

export function HomeTab({ onImport }: { onImport: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const settings = useSettings((s) => s.settings);
  const toast = useSettings((s) => s.toast);
  const link = useSettings((s) => s.link);
  const setTab = useSettings((s) => s.setTab);
  const enqueueProfile = useQueue((s) => s.enqueueProfile);
  const running = useQueue((s) => s.running);
  const [proxyState, setProxyState] = useState<'idle' | 'checking' | 'ok' | 'down'>('idle');
  const [reelAt, setReelAt] = useState<number | null>(null);

  const posts = useLiveQuery(
    async () => {
      const rows = await db.posts.orderBy('createdAt').reverse().limit(300).toArray();
      return rows.filter((p) => {
        if (filter === 'media') return p.media.length > 0;
        if (filter === 'saved') return Boolean(p.savedAt);
        if (filter === 'unread') return Boolean(p.savedAt) && !p.readAt;
        return true;
      }) as PostRecord[];
    },
    [filter],
    [] as PostRecord[],
  );

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);
  const savedRows = useLiveQuery(() => db.posts.where('savedAt').above(0).toArray(), [], [] as PostRecord[]);

  const stats = useMemo(() => {
    const bytes = savedRows.reduce((s, p) => s + (p.sizeBytes ?? 0), 0);
    const unread = savedRows.filter((p) => !p.readAt).length;
    const pendingMedia = savedRows.filter((p) => p.media.some((m) => !m.cached)).length;
    return { count: savedRows.length, bytes, unread, pendingMedia };
  }, [savedRows]);

  const allSaved = useMemo(() => posts.every((p) => p.savedAt) && posts.length > 0, [posts]);

  async function refreshAll() {
    if (!accounts.length) {
      toast('Nie ma jeszcze żadnego profilu — dodaj go w zakładce „Na żywo”.', 'warn');
      setTab('live');
      return;
    }
    const handles = accounts.map((a) => a.handle);
    const n = await enqueueProfile(handles, Math.max(10, Math.min(60, accounts[0]?.fetchCount ?? 20)));
    toast(`Wrzuciłem ${plural(n, 'profil', 'profile', 'profili')} do kolejki`, 'info');
  }

  async function checkProxy() {
    setProxyState('checking');
    const res = await probeProxy();
    setProxyState(res.ok ? 'ok' : 'down');
    toast(
      res.ok ?
        `Proxy działa (upstream: ${res.upstream ?? 'x'}) — mogę pobierać prawdziwe posty.`
      : `Brak serwera proxy pod ${settings.proxyUrl || '/api'}. W APK to nie przeszkadza, w przeglądarce — zobacz zakładkę Ustawienia.`,
      res.ok ? 'ok' : 'warn',
    );
  }

  return (
    <>
      <div className="chips">
        <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          Wszystkie
        </button>
        <button className="chip" aria-pressed={filter === 'media'} onClick={() => setFilter('media')}>
          Z mediami
        </button>
        <button className="chip" aria-pressed={filter === 'saved'} onClick={() => setFilter('saved')}>
          Zapisane ({stats.count})
        </button>
        <button className="chip" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>
          Nieprzeczytane ({stats.unread})
        </button>
        <span className="grow" />
        <button className="chip" onClick={checkProxy} title="Sprawdź, czy serwer proxy odpowiada">
          {proxyState === 'ok' ? 'proxy ✓' : proxyState === 'down' ? 'proxy ✗' : proxyState === 'checking' ? 'sprawdzam…' : 'status-proxy'}
        </button>
      </div>

      {link === 'offline' ? (
        <div className="section" style={{ paddingBottom: 0 }}>
          <div className="banner warn">
            <IconWifiOff style={{ width: 20, height: 20, flex: 'none' }} />
            <div className="grow">
              <b>Jesteś offline.</b>
              <div className="tiny">
                {allSaved ?
                  'Ten ekran zawiera wyłącznie zapisane posty — wszystkie media są w pamięci, więc się nie wysypią.'
                : 'Czeka tu kilka postów bez pobranych mediów. Wejdź w „Zapisane”, żeby zobaczyć tylko to, co na pewno działa bez sieci.'}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {stats.count > 0 ? (
        <div className="section" style={{ paddingBottom: 0 }}>
          <div className="banner info" style={{ alignItems: 'center' }}>
            <IconDownload style={{ width: 20, height: 20, flex: 'none' }} />
            <div className="grow small">
              Masz <b>{plural(stats.count, 'post', 'posty', 'postów')}</b> do czytania bez internetu · {bytesLabel(stats.bytes)}
              {stats.unread ? ` · ${stats.unread} nieprzeczytanych` : ''}
              {stats.pendingMedia ? ` · ${stats.pendingMedia} bez mediów` : ''}
            </div>
            <button className="btn ghost small" onClick={refreshAll} disabled={running}>
              <IconRefresh /> Odśwież
            </button>
          </div>
          {stats.unread ? (
            <button className="btn primary small" style={{ marginTop: 8 }} onClick={() => setTab('offline')}>
              Czytaj dalej ({stats.unread})
            </button>
          ) : null}
        </div>
      ) : null}

      {!posts.length ? (
        <div className="empty">
          <IconCloud />
          <h3>Pusto w pamięci</h3>
          <p className="small">
            Nic nie wstawiamy tu za Ciebie — offline zapełnia się tym, co realnie pobierzesz z X. Otwórz „Na żywo” i
            dodaj profil, wklej linki do postów albo (w APK) włącz podgląd X: apka zapisze to, co przewiniesz.
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" onClick={() => setTab('live')}>
              Dodaj profil / pobierz
            </button>
            <button className="btn ghost" onClick={onImport}>
              Wklej linki do postów
            </button>
          </div>
        </div>
      ) : (
        posts.map((post, i) => (
          <PostCard
            key={post.id}
            post={post}
            onOpen={
              settings.reelMode ?
                () => {
                  if (post.savedAt && !post.readAt) void markRead([post.id]);
                  setReelAt(i);
                }
              : undefined
            }
          />
        ))
      )}

      {reelAt !== null ? <Reel posts={posts} startIndex={reelAt} onClose={() => setReelAt(null)} /> : null}
    </>
  );
}
