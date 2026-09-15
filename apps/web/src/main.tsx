import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/app.css';
import { useSettings, type TabId } from './lib/store';
import { usePwa } from './lib/pwa';
import { db, dbReady, setMeta } from './db/db';
import { tweetIdFromUrl } from './lib/normalize';
import { initNativeBridges } from './lib/native';
import { bridge } from './lib/bridge';
import { maybeReplay } from './lib/actions';
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

/**
 * Link do posta X z zewnątrz (udostępnianie, deep link) otwieramy w podglądzie X —
 * to jedyna droga treści do apki. W przeglądarce (bez podglądu) pokazujemy podpowiedź.
 */
async function openSharedLink(url: string): Promise<void> {
  const st = useSettings.getState();
  if (!tweetIdFromUrl(url)) {
    if (url.trim()) st.toast('Ten link nie wygląda na post z X.', 'warn');
    return;
  }
  const res = await bridge.openLive({ url });
  if (!res.ok) {
    st.toast('Linki z X otwieramy w aplikacji (APK) — tam zapisują się do offline.', 'info');
    st.setTab('x');
    return;
  }
  st.toast('Otwieram post w podglądzie X', 'ok');
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
  await usePwa.getState().init();

  // „Trwałe” miejsce: bez tego Android może wyrzucić zapisane posty przy braku miejsca.
  void ensurePersistentStorage().then((ok) => {
    if (ok) logDiag('info', 'system przyznał trwałe miejsce na dane apki');
  });

  initNativeBridges({
    onResume: () => {
      void maybeReplay().then((r) => {
        if (r.queued) settings.toast(`Wysyłam zaległe akcje do X: ${r.queued}`, 'info');
      });
    },
    onLink: (url) => void openSharedLink(url),
  });

  // Mostek z natywnym podglądem X: posty przy przewijaniu lecą prosto do offline.
  bridge.installDevHook();
  await bridge.startCapturing();
  await bridge.startShareListener((shared) => {
    const text = [shared.url, shared.text, shared.subject].filter(Boolean).join(' ');
    const first = text.split(/[\s,;]+/).find((part) => tweetIdFromUrl(part));
    if (first) void openSharedLink(first);
    else if (text.trim()) settings.toast('Udostępnij apce link do posta X (adres z /status/…).', 'warn');
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
    const first = shared.split(/[\s,;]+/).find((part) => tweetIdFromUrl(part));
    if (first) await openSharedLink(first);
    history.replaceState({}, '', location.pathname);
  }

  // 2) Pierwsze uruchomienie: krótko mówimy, co zrobić.
  const savedCount = await db.posts.where('savedAt').above(0).count();
  if (!savedCount) {
    const seen = await db.meta.get('firstRunTip');
    if (!seen) {
      await setMeta('firstRunTip', Date.now());
      settings.toast('Otwórz zakładkę X i przewiń trochę — posty zapiszą się same.', 'info');
    }
  }

  // 3) Deep link do zakładki (?tab=x). Stare nazwy mapujemy na nowe.
  const tab = params.get('tab');
  const map: Record<string, TabId> = { feed: 'feed', x: 'x', settings: 'settings', home: 'feed', offline: 'feed', live: 'x' };
  if (tab && map[tab]) settings.setTab(map[tab]);
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
