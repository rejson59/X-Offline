import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useQueue } from '@/lib/download';
import { useFill } from '@/lib/autosync';
import { useSettings } from '@/lib/store';
import { bridge, type LiveStatus } from '@/lib/bridge';
import { isNative, probeProxy } from '@/lib/transport';
import { maybeReplay, pendingCount } from '@/lib/actions';
import { demoAccounts } from '@/lib/demo';
import { bytesLabel, plural, relativeTime } from '@/lib/format';
import {
  IconBookmark,
  IconCloud,
  IconDownload,
  IconExternal,
  IconQueue,
  IconRefresh,
  IconSpinner,
} from './Icons';

const COUNTS = [10, 25, 50, 100];
const TARGETS = [50, 100, 200, 500];

/** Krótki opis stanu zbierania w podglądzie X. */
function liveSummary(live: LiveStatus): string {
  if (!live.open) return 'Posty zbieramy przy przewijaniu — otwórz X, żeby zacząć.';
  const got = live.captured ?? 0;
  const target = live.target ? `/${live.target}` : '';
  const parts = [`Zebrane w podglądzie: ${got}${target}`];
  if (live.scrolling) parts.push('przewijam');
  if (live.enabled === false) parts.push('zbieranie wyłączone');
  if (live.loggedIn === false) parts.push('wygląda, że nie jesteś zalogowany');
  return parts.join(' · ') + '.';
}

export function LiveTab() {
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const toast = useSettings((s) => s.toast);
  const online = useSettings((s) => s.online);
  const enqueueProfile = useQueue((s) => s.enqueueProfile);
  const running = useQueue((s) => s.running);
  const savedCount = useQueue((s) => s.savedCount);
  const totalBytes = useQueue((s) => s.totalBytes);

  const fill = useFill();
  const [handle, setHandle] = useState('');
  const [count, setCount] = useState(25);
  const [frameKey, setFrameKey] = useState(0);
  const [proxy, setProxy] = useState<{ ok: boolean; note: string }>({ ok: false, note: 'sprawdzam…' });
  const [live, setLive] = useState<LiveStatus>({ open: false });
  const [pending, setPending] = useState(0);

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);

  useEffect(() => {
    void probeProxy().then((res) =>
      setProxy({
        ok: res.ok,
        note: res.ok ? `proxy gotowe${res.upstream ? ` · upstream: ${res.upstream}` : ''}` : (res.error ?? 'proxy nie odpowiada'),
      }),
    );
    void pendingCount().then(setPending);
    void bridge.status().then(setLive);
  }, [settings.proxyUrl, pending]);

  // Gdy podgląd X jest otwarty, licznik zebranych postów ma tykać sam z siebie.
  useEffect(() => {
    if (!live.open) return;
    const t = window.setInterval(() => void bridge.status().then(setLive), 2500);
    return () => window.clearInterval(t);
  }, [live.open]);

  const frameUrl = useMemo(() => {
    const h = (handle || accounts[0]?.handle || demoAccounts[0]?.handle || 'XDevelopers').replace('@', '');
    return settings.liveFrameTemplate.replace('{handle}', encodeURIComponent(h));
  }, [handle, accounts, settings.liveFrameTemplate]);

  async function fetchOne(h: string, n = count) {
    const added = await enqueueProfile([h], n);
    if (added) toast(`Pobieranie @${h.replace('@', '')} — ${n} postów w kolejce`, 'info');
  }

  async function openX() {
    const res = await bridge.openLive({ tab: 'home', autoScroll: settings.autoScroll, maxPosts: settings.scrollBatch * 12 });
    if (!res.ok) toast(res.error ?? 'Podgląd na żywo jest tylko w APK', 'warn');
    else setLive({ open: true, loggedIn: true });
  }

  async function grabBookmarks() {
    const res = await bridge.openLive({ tab: 'bookmarks', capture: true, autoScroll: false });
    if (!res.ok) toast(res.error ?? 'Lustrzanka zakładek działa w APK (potrzebna Twoja sesja X)', 'warn');
    else toast('Otwieram zakładki X — posty stąd wskakują do offline', 'ok');
  }

  async function flushActions() {
    const res = await maybeReplay();
    if (res.queued) toast(`Klikam w X: ${res.queued} akcji — wynik za chwilę`, 'ok');
    else if (res.sent) toast(`Wysłane akcje: ${res.sent}`, 'ok');
    else if (res.reason) toast(`Akcje czekają: ${res.reason}`, 'warn');
    else toast('Brak zaległych akcji', 'info');
    setPending(await pendingCount());
  }

  const pct = fill.target ? Math.min(100, Math.round((fill.saved / fill.target) * 100)) : 0;

  return (
    <>
      {/* ——— auto-offline: serce apki ——— */}
      <div className="section" style={{ paddingBottom: 10 }}>
        <div className="banner" style={{ marginTop: 0, flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
          <div className="row">
            <IconCloud style={{ width: 22, height: 22, flex: 'none', color: 'var(--accent)' }} />
            <div className="grow">
              <b>Automatyczny offline</b>
              <div className="tiny dim">
                {isNative() ?
                  'Zapisujemy wszystko, co mija Twój wzrok w podglądzie X — Ty nie klikasz nic.'
                :
                  'W przeglądarce nie mamy Twojej sesji, więc dociągamy partiami z listy kont. W APK dochodzi do tego zbieranie przy przewijaniu.'}
              </div>
            </div>
            <span className="badge info">
              {fill.saved}/{settings.autoTarget}
            </span>
          </div>

          <div className="chips" style={{ paddingInline: 0, borderBottom: 0, margin: 0 }}>
            {TARGETS.map((n) => (
              <button
                key={n}
                className="chip"
                aria-pressed={settings.autoTarget === n}
                onClick={() => patch({ autoTarget: n })}
              >
                {n} postów
              </button>
            ))}
            <button
              className="chip"
              aria-pressed={settings.autoCapture}
              onClick={() => patch({ autoCapture: !settings.autoCapture })}
              title="Zapisywanie napotkanych postów w podglądzie na żywo"
            >
              {settings.autoCapture ? 'auto-zapis: wł.' : 'auto-zapis: wył.'}
            </button>
            <button
              className="chip"
              aria-pressed={settings.autoScroll}
              onClick={() => patch({ autoScroll: !settings.autoScroll })}
              title="Samo przewijanie feedu, żeby zebrać partię"
            >
              {settings.autoScroll ? 'auto-scroll: wł.' : 'auto-scroll: wył.'}
            </button>
          </div>

          <div className="progress">
            <i style={{ width: `${pct}%` }} />
          </div>

          <div className="row wrap">
            {fill.running ? (
              <button className="btn danger" onClick={() => fill.stop()}>
                <IconSpinner /> Zatrzymaj ({fill.saved})
              </button>
            ) : (
              <button className="btn primary" onClick={() => void fill.start()}>
                <IconDownload /> Załaduj {settings.autoTarget} postów
              </button>
            )}
            <span className="tiny dim">
              {fill.running ?
                `runda ${fill.round} · zebrano ${fill.saved}${fill.bytes ? ` · ${bytesLabel(fill.bytes)}` : ''}`
              : savedCount ?
                `${plural(savedCount, 'post', 'posty', 'postów')} w offline (${bytesLabel(totalBytes)})`
              :
                'offline jest puste'}
            </span>
          </div>

          {fill.log.length ? (
            <details className="acc" open={fill.running} style={{ margin: 0 }}>
              <summary className="tiny">dziennik pobierania ({fill.log.length})</summary>
              {fill.log.slice(0, 12).map((l, i) => (
                <div className={`tiny ${l.kind === 'error' ? 'dim' : 'dim'}`} key={`${l.at}-${i}`} style={{ padding: '2px 0' }}>
                  {new Date(l.at).toLocaleTimeString('pl-PL')} · {l.text}
                </div>
              ))}
            </details>
          ) : null}
        </div>
      </div>

      {/* ——— prawdziwe X w środku apki (natywne) ——— */}
      <div className="section" style={{ paddingTop: 0 }}>
        <h3 style={{ marginTop: 4 }}>X w aplikacji {isNative() ? '' : '(tylko APK)'}</h3>
        <div className="list">
          <div className="list-item">
            <div className="grow">
              <div className="small">
                <b>Przeglądaj i loguj się normalnie</b>
              </div>
              <div className="tiny dim">
                {isNative() ?
                  `Natywny WebView z Twoimi ciasteczkami. ${liveSummary(live)}`
                :
                  'Wersja przeglądarkowa nie może trzymać sesji X (ciasteczka są tylko na x.com). Zainstaluj APK, żeby mieć logowanie + auto-zapis.'}
              </div>
            </div>
            <button className="btn primary small" onClick={openX}>
              Otwórz X
            </button>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="small">
                <b>Zakładki X → offline</b>
              </div>
              <div className="tiny dim">
                To, co zapisujesz w samym X (ikona zakładki), trafia do naszej bazy automatycznie
                {settings.mirrorBookmarks ? ' (lustrzanka włączona)' : ' (włącz ją w ustawieniach)'}.
              </div>
            </div>
            <button className="btn ghost small" onClick={grabBookmarks}>
              <IconBookmark /> Ściągnij
            </button>
          </div>
          <div className="list-item">
            <div className="grow">
              <div className="small">
                <b>Zaległe akcje</b>
              </div>
              <div className="tiny dim">
                Polubienia i zakładki kliknięte w offline lecą do X, gdy tylko złapiemy łącze.
              </div>
            </div>
            <button className="btn ghost small" onClick={flushActions} disabled={!pending}>
              <IconQueue /> {pending ? `Wyślij ${pending}` : 'brak'}
            </button>
          </div>
        </div>
      </div>

      {/* ——— ręczne pobieranie profilu ——— */}
      <div className="section" style={{ paddingTop: 0 }}>
        <h3>Jednorazowo: konkretny profil</h3>
        <div className="row" style={{ gap: 8 }}>
          <div className="grow" style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: 9, color: 'var(--text-dim)', fontWeight: 800 }}>@</span>
            <input
              className="field"
              style={{ paddingLeft: 26 }}
              placeholder="nazwa profilu, np. nasa"
              value={handle}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setHandle(e.target.value.replace(/^@/, ''))}
            />
          </div>
          <button
            className="btn primary"
            onClick={() => fetchOne(handle || (accounts[0]?.handle ?? demoAccounts[0].handle))}
            disabled={running}
          >
            <IconDownload /> Pobierz
          </button>
        </div>
        <div className="chips" style={{ paddingInline: 0, borderBottom: 0, marginTop: 8 }}>
          {COUNTS.map((n) => (
            <button key={n} className="chip" aria-pressed={count === n} onClick={() => setCount(n)}>
              {n} postów
            </button>
          ))}
        </div>
        <div className={`banner ${online && (isNative() || proxy.ok) ? 'info' : 'warn'}`}>
          <div className="grow small">
            <b>{isNative() ? 'Tryb natywny' : 'Tryb przeglądarkowy'}</b>
            <div className="tiny" style={{ marginTop: 3 }}>
              {isNative() ?
                'Zapytania idą przez sieć natywną — bez proxy i bez CORS.'
              : proxy.ok ?
                `Proxy: ${proxy.note}.`
              :
                'Proxy nie odpowiada — pobieranie realnych postów zadziała po `npm run dev:server` albo po wystawieniu `cloudflare/worker.mjs`. Teraz dostaniesz dane demo.'}
            </div>
          </div>
        </div>
      </div>

      {/* ——— profile ——— */}
      <div className="section" style={{ paddingTop: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Konta z listy</h3>
          <button className="btn ghost small" onClick={() => void fill.start()} disabled={fill.running}>
            Dociągnij do celu
          </button>
        </div>
        <div className="list" style={{ marginTop: 8 }}>
          {(accounts.length ? accounts : demoAccounts.map((a) => ({ ...a, lastSyncAt: null, savedCount: 0 }))).map(
            (a) => (
              <div className="list-item" key={a.handle}>
                <div className="grow">
                  <div className="row tight">
                    <b className="small">{a.name ?? a.handle}</b>
                    <span className="handle tiny dim">@{a.handle}</span>
                  </div>
                  <div className="tiny dim">
                    {a.savedCount ? `${a.savedCount} zapisanych · ` : ''}
                    {a.lastSyncAt ? `świeżość: ${relativeTime(a.lastSyncAt)}` : 'jeszcze nieciągane'}
                    {a.description ? ` · ${a.description}` : ''}
                  </div>
                </div>
                <button className="btn ghost small" onClick={() => fetchOne(a.handle)} disabled={running}>
                  <IconDownload /> {count}
                </button>
              </div>
            ),
          )}
        </div>
      </div>

      {/* ——— iframe (dla każdego) ——— */}
      <div className="section" style={{ paddingTop: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Podgląd w ramce</h3>
          <div className="row tight">
            <button className="icon-btn" onClick={() => setFrameKey((k) => k + 1)} aria-label="Odśwież podgląd">
              <IconRefresh />
            </button>
            <a className="icon-btn" href={frameUrl} target="_blank" rel="noreferrer" aria-label="Otwórz podgląd w nowej karcie">
              <IconExternal />
            </a>
          </div>
        </div>
        <div className="frame-wrap">
          {!online ? (
            <div className="frame-fallback">
              <b>Brak łącza</b>
              <p className="small" style={{ margin: 0 }}>
                Zajrzyj do „Zapisanych” — tam nic nie zależy od sieci.
              </p>
            </div>
          ) : (
            <iframe
              key={`${frameUrl}-${frameKey}`}
              src={frameUrl}
              title={`Podgląd profilu @${handle || 'wybranego'}`}
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          )}
        </div>
        <p className="tiny dim" style={{ marginTop: 8 }}>
          Ramka pokazuje publicznie osadzone timeline. Nie da się z niej wyciągnąć treści skryptem (inna domena) —
          dlatego auto-zapis idzie własną ścieżką.
        </p>
      </div>
    </>
  );
}
