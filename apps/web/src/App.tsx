import { useEffect, useState } from 'react';
import { useSettings, type TabId } from '@/lib/store';
import { useQueue } from '@/lib/download';
import { usePwa } from '@/lib/pwa';
import { plural } from '@/lib/format';
import { HomeTab } from './components/HomeTab';
import { OfflineTab } from './components/OfflineTab';
import { LiveTab } from './components/LiveTab';
import { SettingsTab } from './components/SettingsTab';
import { ImportSheet, QueueSheet, Toasts } from './components/Sheets';
import {
  IconBookmark,
  IconDownload,
  IconHome,
  IconLive,
  IconSettings,
  IconWifiOff,
  IconX,
} from './components/Icons';

const TITLES: Record<TabId, { title: string; sub: string }> = {
  home: { title: 'X-Offline', sub: 'Twoja oś czasu, nawet bez łącza' },
  live: { title: 'Na żywo', sub: 'Pobierz i zajrzyj do profilu' },
  offline: { title: 'Zapisane', sub: 'Działa w samolocie' },
  settings: { title: 'Ustawienia', sub: 'Źródło danych, miejsce, czytanie' },
};

export function App() {
  const tab = useSettings((s) => s.tab);
  const setTab = useSettings((s) => s.setTab);
  const link = useSettings((s) => s.link);
  const toast = useSettings((s) => s.toast);
  const savedCount = useQueue((s) => s.savedCount);
  const running = useQueue((s) => s.running);
  const needRefresh = usePwa((s) => s.needRefresh);
  const updateSW = usePwa((s) => s.updateSW);
  const canInstall = usePwa((s) => s.canInstall);
  const install = usePwa((s) => s.install);
  const offlineReady = usePwa((s) => s.offlineReady);
  const [queueOpen, setQueueOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (offlineReady) toast('Aplikacja gotowa do pracy offline', 'ok');
  }, [offlineReady, toast]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="grow">
          <h1 className="row tight" style={{ gap: 7 }}>
            <IconX style={{ width: 21, height: 21 }} />
            {TITLES[tab].title}
          </h1>
          <div className="sub">{TITLES[tab].sub}</div>
        </div>

        {link !== 'ok' ? (
          <span className={`badge ${link === 'offline' ? 'warn' : 'info'}`} title={link === 'offline' ? 'Brak internetu' : 'Słabe łącze'}>
            {link === 'offline' ? <IconWifiOff style={{ width: 13, height: 13 }} /> : <IconLive style={{ width: 13, height: 13 }} />}
            {link === 'offline' ? 'offline' : 'słabe łącze'}
          </span>
        ) : null}

        {savedCount ? (
          <span className="badge" title="Zapisane posty">
            <IconBookmark style={{ width: 13, height: 13 }} />
            {plural(savedCount, 'post', 'posty', 'postów')}
          </span>
        ) : null}

        {canInstall ? (
          <button
            className="btn small primary"
            onClick={async () => {
              const r = await install();
              toast(r === 'accepted' ? 'Instaluję aplikację…' : 'Instalacja odrzucona', r === 'accepted' ? 'ok' : 'info');
            }}
          >
            Zainstaluj
          </button>
        ) : null}
      </header>

      {needRefresh && updateSW ? (
        <div className="section" style={{ paddingBottom: 0 }}>
          <div className="banner info" style={{ marginTop: 0, alignItems: 'center' }}>
            <div className="grow small">
              Jest nowsza wersja aplikacji (twoje zapisane posty zostają nietknięte).
            </div>
            <button className="btn small" onClick={() => void updateSW(true)}>
              Odśwież
            </button>
          </div>
        </div>
      ) : null}

      <main className="app-body">
        {tab === 'home' ? <HomeTab onImport={() => setImportOpen(true)} /> : null}
        {tab === 'live' ? <LiveTab /> : null}
        {tab === 'offline' ? <OfflineTab /> : null}
        {tab === 'settings' ? <SettingsTab /> : null}
      </main>

      <button className="fab" onClick={() => setQueueOpen(true)} aria-label="Kolejka pobierania">
        <IconDownload />
        {running ? 'pobieram…' : 'Pobierz'}
        {savedCount ? <span className="badge-count">{savedCount}</span> : null}
      </button>

      <nav className="tabbar" aria-label="Główna nawigacja">
        {(
          [
            ['home', 'Start', <IconHome key="h" />],
            ['live', 'Na żywo', <IconLive key="l" />],
            ['offline', 'Zapisane', <IconBookmark key="b" />],
            ['settings', 'Ustawienia', <IconSettings key="s" />],
          ] as [TabId, string, React.ReactNode][]
        ).map(([id, label, icon]) => (
          <button key={id} className="tab" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            {icon}
            <span>{label}</span>
            {running && id === 'live' ? <span className="dot" /> : null}
          </button>
        ))}
      </nav>

      {queueOpen ? <QueueSheet onClose={() => setQueueOpen(false)} /> : null}
      {importOpen ? <ImportSheet onClose={() => setImportOpen(false)} /> : null}

      <Toasts />
    </div>
  );
}
