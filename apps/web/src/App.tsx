import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useSettings, type TabId } from '@/lib/store';
import { usePwa } from '@/lib/pwa';
import { FeedTab } from './components/FeedTab';
import { BrowseTab } from './components/BrowseTab';
import { SettingsTab } from './components/SettingsTab';
import { ActionsSheet, Toasts } from './components/Sheets';
import { useActionList } from './lib/actionsView';
import { IconBook, IconQueue, IconSettings, IconX } from './components/Icons';

const TITLES: Record<TabId, string> = {
  feed: 'Zapisane',
  x: 'X',
  settings: 'Ustawienia',
};

export function App() {
  const tab = useSettings((s) => s.tab);
  const setTab = useSettings((s) => s.setTab);
  const link = useSettings((s) => s.link);
  const toast = useSettings((s) => s.toast);
  const needRefresh = usePwa((s) => s.needRefresh);
  const updateSW = usePwa((s) => s.updateSW);
  const canInstall = usePwa((s) => s.canInstall);
  const install = usePwa((s) => s.install);
  const offlineReady = usePwa((s) => s.offlineReady);
  const [actionsOpen, setActionsOpen] = useState(false);
  const fontSize = useSettings((s) => s.settings.fontSize);
  const { stats } = useActionList();
  const unread = useLiveQuery(
    async () => (await db.posts.where('savedAt').above(0).toArray()).filter((p) => !p.readAt).length,
    [],
    0,
  );

  useEffect(() => {
    if (offlineReady) toast('Gotowe do pracy offline', 'ok');
  }, [offlineReady, toast]);

  return (
    <div className="app" style={{ ['--post-fs' as string]: `${fontSize}px` }}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <IconX />
          </span>
          <h1>{TITLES[tab]}</h1>
        </div>
        <span className="spacer" />

        <span
          className={`net-dot ${link}`}
          title={link === 'offline' ? 'Brak internetu' : link === 'slow' ? 'Słabe łącze' : 'Połączono'}
          aria-label={link === 'offline' ? 'Brak internetu' : link === 'slow' ? 'Słabe łącze' : 'Połączono'}
        />

        {stats.pending ? (
          <button
            className="icon-btn subtle"
            onClick={() => setActionsOpen(true)}
            aria-label={`${stats.pending} akcji czeka na wysyłkę do X`}
            title="Akcje czekające na wysyłkę do X"
          >
            <IconQueue />
            <span className="mini-count">{stats.pending}</span>
          </button>
        ) : null}

        {canInstall ? (
          <button
            className="btn small quiet"
            onClick={async () => {
              const r = await install();
              toast(r === 'accepted' ? 'Instaluję…' : 'Instalacja odrzucona', r === 'accepted' ? 'ok' : 'info');
            }}
          >
            Zainstaluj
          </button>
        ) : null}
      </header>

      {needRefresh && updateSW ? (
        <div className="update-strip">
          <span>Dostępna jest nowsza wersja.</span>
          <button className="btn small quiet" onClick={() => void updateSW(true)}>
            Odśwież
          </button>
        </div>
      ) : null}

      <main className="app-body" key={tab}>
        {tab === 'feed' ? <FeedTab /> : null}
        {tab === 'x' ? <BrowseTab /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
      </main>

      <nav className="tabbar" aria-label="Główna nawigacja">
        {(
          [
            ['feed', 'Zapisane', <IconBook key="f" />],
            ['x', 'X', <IconX key="x" />],
            ['settings', 'Ustawienia', <IconSettings key="s" />],
          ] as [TabId, string, React.ReactNode][]
        ).map(([id, label, icon]) => (
          <button key={id} className="tab" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            <span className="tab-pill">{icon}</span>
            <span>{label}</span>
            {unread > 0 && id === 'feed' && tab !== 'feed' ? (
              <span className="badge-count" aria-hidden="true">
                {unread > 99 ? '99+' : unread}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {actionsOpen ? <ActionsSheet onClose={() => setActionsOpen(false)} /> : null}

      <Toasts />
    </div>
  );
}
