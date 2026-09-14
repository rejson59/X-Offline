import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { PostCard } from './PostCard';
import { Reel } from './Reel';
import { useSettings } from '@/lib/store';
import { useQueue } from '@/lib/download';
import { probeProxy } from '@/lib/transport';
import { bytesLabel, plural } from '@/lib/format';
import { ensureDemoSeeded } from '@/lib/demo';
import type { PostRecord } from '@/lib/types';
import { IconDownload, IconRefresh, IconWifiOff } from './Icons';

type Filter = 'all' | 'media' | 'saved';

export function HomeTab({ onImport }: { onImport: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const settings = useSettings((s) => s.settings);
  const toast = useSettings((s) => s.toast);
  const link = useSettings((s) => s.link);
  const enqueueProfile = useQueue((s) => s.enqueueProfile);
  const running = useQueue((s) => s.running);
  const [proxyState, setProxyState] = useState<'idle' | 'checking' | 'ok' | 'down'>('idle');

  const posts = useLiveQuery(
    async () => {
      const rows = await db.posts.orderBy('createdAt').reverse().limit(200).toArray();
      return rows.filter((p) => {
        if (filter === 'media') return p.media.length > 0;
        if (filter === 'saved') return Boolean(p.savedAt);
        return true;
      }) as PostRecord[];
    },
    [filter],
    [] as PostRecord[],
  );

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);
  const savedStats = useLiveQuery(
    async () => {
      const rows = await db.posts.where('savedAt').above(0).toArray();
      return { count: rows.length, bytes: rows.reduce((s, p) => s + (p.sizeBytes ?? 0), 0) };
    },
    [],
    { count: 0, bytes: 0 },
  );

  const allSaved = useMemo(() => posts.every((p) => p.savedAt) && posts.length > 0, [posts]);
  const [reelAt, setReelAt] = useState<number | null>(null);

  async function refreshAll() {
    if (!accounts.length) {
      await ensureDemoSeeded();
      toast('Brak kont do odświeżenia — załadowałem zestaw demo.', 'warn');
      return;
    }
    const handles = accounts.map((a) => a.handle);
    const n = await enqueueProfile(handles, Math.max(10, Math.min(60, accounts[0]?.fetchCount ?? 20)));
    toast(`Wrzuciłem ${plural(n, 'profil', 'profile', 'profilów')} do kolejki`, 'info');
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
          Zapisane ({savedStats.count})
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
                :
                  'Czeka tu kilka postów bez pobranych mediów. Wejdź w „Zapisane”, żeby zobaczyć tylko to, co na pewno działa bez sieci.'}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {savedStats.count > 0 ? (
        <div className="section" style={{ paddingBottom: 0 }}>
          <div className="banner info" style={{ alignItems: 'center' }}>
            <IconDownload style={{ width: 20, height: 20, flex: 'none' }} />
            <div className="grow small">
              Masz <b>{plural(savedStats.count, 'post', 'posty', 'postów')}</b> do czytania bez internetu ·{' '}
              {bytesLabel(savedStats.bytes)}
            </div>
            <button className="btn ghost small" onClick={refreshAll} disabled={running}>
              <IconRefresh /> Odśwież
            </button>
          </div>
        </div>
      ) : null}

      {!posts.length ? (
        <div className="empty">
          <IconDownload />
          <h3>Pusto w pamięci</h3>
          <p className="small">
            Otwórz „Na żywo”, wybierz profile i kliknij <b>Pobierz</b>. Albo wrzuć konkretne linki — i czytaj później
            w metrze.
          </p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <button className="btn primary" onClick={onImport}>
              Wklej linki do postów
            </button>
          </div>
        </div>
      ) : (
        posts.map((post, i) => (
          <PostCard key={post.id} post={post} onOpen={settings.reelMode ? () => setReelAt(i) : undefined} />
        ))
      )}

      {reelAt !== null ? <Reel posts={posts} startIndex={reelAt} onClose={() => setReelAt(null)} /> : null}
    </>
  );
}
