import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { useSettings } from './lib/store';
import { useQueue } from './lib/download';
import { usePwa } from './lib/pwa';
import { ensureDemoSeeded } from './lib/demo';
import { getMeta, setMeta } from './db/db';
import { refreshAccountCounts, saveOffline } from './lib/posts';
import { tweetIdFromUrl } from './lib/normalize';
import { db } from './db/db';
import { initNativeBridges } from './lib/native';

async function boot(): Promise<void> {
  const settings = useSettings.getState();
  await settings.hydrate();
  const seeded = await ensureDemoSeeded();
  await refreshAccountCounts();
  await useQueue.getState().refreshTotals();
  await usePwa.getState().init();
  initNativeBridges(() => {
    void refreshAccountCounts();
    void useQueue.getState().refreshTotals();
  });
  settings.refreshNet();

  if (seeded) {
    settings.toast(`Zestaw demo: ${seeded} postów gotowych do zapisu offline`, 'info');
    // Przy pierwszym uruchomieniu odkładamy kilka postów sami — żeby „Zapisane” nie było puste,
    // a tryb offline dało się sprawdzić jednym przełączeniem trybu samolotowego.
    const welcome = await getMeta('welcomeSeeded', false);
    if (!welcome) {
      await setMeta('welcomeSeeded', true);
      const candidates = (await db.posts.orderBy('createdAt').reverse().toArray())
        .filter((p) => p.media.length > 0)
        .slice(0, 6);
      for (const post of candidates) await saveOffline(post);
      await useQueue.getState().refreshTotals();
      if (candidates.length) {
        settings.toast(`Na dobry początek zapisałem offline ${candidates.length} postów`, 'ok');
      }
    }
  }

  // 1) Udostępnianie z X / share target PWA: /?import=1&url=https://x.com/u/status/123
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (params.get('import') === '1' && shared) {
    const links = shared.split(/[\s,;]+/).filter((l) => tweetIdFromUrl(l));
    if (links.length) {
      await useQueue.getState().enqueueLinks(links);
      settings.toast(`Z udostępniania: ${links.length} linków w kolejce`, 'ok');
    }
    history.replaceState({}, '', location.pathname);
  }

  const tab = params.get('tab');
  if (tab === 'offline' || tab === 'live' || tab === 'home' || tab === 'settings') settings.setTab(tab);

  // 2) Opcjonalne odświeżenie zapisanych kont przy starcie.
  if (settings.settings.autoSyncOnOpen && navigator.onLine) {
    const accounts = await db.accounts.toArray();
    const marked = accounts.filter((a) => a.autoSync).map((a) => a.handle);
    const handles = marked.length ? marked : accounts.slice(0, 3).map((a) => a.handle);
    if (handles.length) {
      await useQueue.getState().enqueueProfile(handles, 25);
      settings.toast(`Aktualizuję zapisane profile: ${handles.map((h) => `@${h}`).join(', ')}`, 'info');
    }
  }
}

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
