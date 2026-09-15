import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/app.css';
import { useSettings } from './lib/store';
import { useQueue } from './lib/download';
import { usePwa } from './lib/pwa';
import { db, dbReady, setMeta } from './db/db';
import { refreshAccountCounts, rememberAccount } from './lib/posts';
import { tweetIdFromUrl } from './lib/normalize';
import { initNativeBridges } from './lib/native';
import { bridge } from './lib/bridge';
import { maybeReplay } from './lib/actions';
import { shouldAutoFillOnOpen, useFill } from './lib/autosync';
import { installGlobalErrorHandlers, logDiag, logError, useDiagnostics } from './lib/diagnostics';
import { ensurePersistentStorage } from './lib/media';

installGlobalErrorHandlers();

/** Ekran ratunkowy, gdy IndexedDB w ogóle nie wstaje (tryb prywatny, zablokowane dane). */
function renderFatal(detail: string): void {
  const root = document.getElementById('root');
  if (!root) return;
  root.innerHTML = `
    <div class="section" style="padding:24px 18px">
      <h2>Nie da się otworzyć pamięci urządzenia</h2>
      <p class="small">X-Offline trzyma posty w lokalnej bazie (IndexedDB). System właśnie jej nie udostępnia —
      najczęściej przez tryb prywatny albo zablokowane „dane witryn”.</p>
      <ul class="small dim">
        <li>wyłącz tryb prywatny / incognito,</li>
        <li>w ustawieniach przeglądarki/apki zezwól na zapisywanie danych witryn,</li>
        <li>jeśli masz mało miejsca — zwolnij trochę i odśwież apkę.</li>
      </ul>
      <p class="tiny dim" style="word-break:break-word">${detail.replace(/[<>&]/g, '')}</p>
      <button class="btn primary small" onclick="location.reload()">Spróbuj ponownie</button>
    </div>`;
}

function toast0(text: string): void {
  useSettings.getState().toast(text, 'info');
}

async function boot(): Promise<void> {
  const settings = useSettings.getState();

  // 0) Baza musi wstać, zanim cokolwiek z niej czytamy (wcześniej brak obsługi = pusty ekran).
  const ready = await dbReady();
  if (!ready.ok) {
    logDiag('error', `baza nie wystartowała: ${ready.error}`);
    renderFatal(ready.error);
    return;
  }

  await settings.hydrate();
  await useDiagnostics.getState().hydrate();
  await refreshAccountCounts().catch((err) => logError('liczniki kont', err));
  await useQueue.getState().refreshTotals().catch((err) => logError('liczniki biblioteki', err));
  await usePwa.getState().init();

  // „Trwałe” miejsce: bez tego Android może wyrzucić zapisane posty przy braku miejsca.
  void ensurePersistentStorage().then((ok) => {
    if (ok) logDiag('info', 'system przyznał trwałe miejsce na dane apki');
  });

  // Linki z zewnątrz (share sheet / deep link) → kolejka pobierania.
  const enqueueLinks = async (links: string[], why: string) => {
    const clean = links.filter((l) => tweetIdFromUrl(l));
    if (!clean.length) {
      if (links.some((l) => l.trim())) {
        settings.toast('Ten link nie wygląda na post z X (potrzebny adres z /status/…).', 'warn');
      }
      return;
    }
    await useQueue.getState().enqueueLinks(clean);
    settings.toast(`${why}: ${clean.length} ${clean.length === 1 ? 'link' : 'linki'} w kolejce`, 'ok');
    useSettings.getState().setTab('home');
  };

  initNativeBridges({
    onResume: () => {
      void refreshAccountCounts();
      void useQueue.getState().refreshTotals();
      void maybeReplay().then((r) => {
        if (r.queued) settings.toast(`Wysyłam zaległe akcje do X: ${r.queued}`, 'info');
      });
    },
    onLink: (url) => void enqueueLinks([url], 'Z udostępniania'),
  });

  // Mostek z natywnym podglądem X: posty przy przewijaniu lecą prosto do offline.
  bridge.installDevHook();
  await bridge.startCapturing();
  await bridge.startShareListener((shared) => {
    const text = [shared.url, shared.text, shared.subject].filter(Boolean).join(' ');
    void enqueueLinks(text.split(/[\s,;]+/), 'Z udostępniania');
  });

  // Łącze wróciło? Wyślij, co czekało.
  window.addEventListener('online', () => {
    void maybeReplay().then((r) => {
      if (r.queued) settings.toast(`Wysyłam zaległe akcje do X: ${r.queued}`, 'ok');
    });
  });
  settings.refreshNet();

  // 1) Udostępnianie z X / share target PWA: /?import=1&url=https://x.com/u/status/123
  const params = new URLSearchParams(location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (params.get('import') === '1' && shared) {
    await enqueueLinks(shared.split(/[\s,;]+/), 'Z udostępniania');
    history.replaceState({}, '', location.pathname);
  }

  // 2) Pierwsze uruchomienie: nie ma czym się chwalić, więc mówimy wprost co zrobić.
  const [savedCount, accountCount] = await Promise.all([db.posts.where('savedAt').above(0).count(), db.accounts.count()]);
  if (!savedCount && !accountCount) {
    const seen = await db.meta.get('firstRunTip');
    if (!seen) {
      await setMeta('firstRunTip', Date.now());
      settings.toast('Zacznij od „Na żywo”: dodaj profil albo otwórz X w podglądzie (APK zbiera, co przewiniesz).', 'info');
    }
  }

  // 3) Auto-dokarmianie offline przy starcie (żeby rano w pociągu było co czytać).
  if (await shouldAutoFillOnOpen()) {
    toast0('Dociągam partię postów do offline…');
    void useFill.getState().start();
  }

  const tab = params.get('tab');
  if (tab === 'offline' || tab === 'live' || tab === 'home' || tab === 'settings') settings.setTab(tab);

  // 4) Opcjonalne odświeżenie zapisanych kont przy starcie.
  if (useSettings.getState().settings.autoSyncOnOpen && navigator.onLine) {
    const accounts = await db.accounts.toArray();
    const marked = accounts.filter((a) => a.autoSync).map((a) => a.handle);
    const handles = marked.length ? marked : accounts.slice(0, 3).map((a) => a.handle);
    for (const h of handles) await rememberAccount(h, { fetchCount: 25 });
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
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}

void boot().catch((err) => {
  logError('start aplikacji', err);
  renderFatal(String((err as Error)?.message ?? err));
});
