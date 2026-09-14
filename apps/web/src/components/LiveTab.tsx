import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useQueue } from '@/lib/download';
import { useSettings } from '@/lib/store';
import { isNative, probeProxy } from '@/lib/transport';
import { demoAccounts } from '@/lib/demo';
import { relativeTime } from '@/lib/format';
import { IconCloud, IconDownload, IconExternal, IconRefresh } from './Icons';

const COUNTS = [10, 25, 50, 100];

export function LiveTab() {
  const settings = useSettings((s) => s.settings);
  const toast = useSettings((s) => s.toast);
  const online = useSettings((s) => s.online);
  const enqueueProfile = useQueue((s) => s.enqueueProfile);
  const running = useQueue((s) => s.running);
  const [handle, setHandle] = useState('');
  const [count, setCount] = useState(25);
  const [frameKey, setFrameKey] = useState(0);
  const [frameState, setFrameState] = useState<'loading' | 'loaded' | 'blocked'>('loading');
  const [proxy, setProxy] = useState<{ ok: boolean; note: string }>({ ok: false, note: 'sprawdzam…' });

  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);

  useEffect(() => {
    let alive = true;
    void probeProxy().then((res) => {
      if (!alive) return;
      setProxy({
        ok: res.ok,
        note: res.ok ? `proxy gotowe${res.upstream ? ` · upstream: ${res.upstream}` : ''}` : (res.error ?? 'proxy nie odpowiada'),
      });
    });
    return () => {
      alive = false;
    };
  }, [settings.proxyUrl]);

  const frameUrl = useMemo(() => {
    const h = (handle || accounts[0]?.handle || demoAccounts[0]?.handle || 'XDevelopers').replace('@', '');
    return settings.liveFrameTemplate.replace('{handle}', encodeURIComponent(h));
  }, [handle, accounts, settings.liveFrameTemplate]);

  async function fetchOne(h: string, n = count) {
    const added = await enqueueProfile([h], n);
    if (added) toast(`Pobieranie @${h.replace('@', '')} — ${n} postów w kolejce`, 'info');
  }

  async function fetchMany(handles: string[]) {
    const added = await enqueueProfile(handles, count);
    toast(`W kolejce: ${added} ${added === 1 ? 'profil' : 'profile'}`, 'info');
  }

  const blocked = !online || (settings.sourceMode !== 'direct' && !proxy.ok && !isNative());

  return (
    <>
      <div className="section" style={{ paddingBottom: 8 }}>
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
          <button className="btn primary" onClick={() => fetchOne(handle || (accounts[0]?.handle ?? demoAccounts[0].handle))} disabled={running}>
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

        <div className={`banner ${blocked ? 'warn' : 'info'}`}>
          <IconCloud style={{ width: 20, height: 20, flex: 'none' }} />
          <div className="grow small">
            <b>{isNative() ? 'Tryb natywny (APK)' : 'Tryb przeglądarkowy'}</b>
            <div className="tiny" style={{ marginTop: 3 }}>
              {isNative() ?
                'Zapytania lecą przez sieć natywną, więc nie obchodzi ich CORS — pobieranie działa bez żadnego serwera.'
              : proxy.ok ?
                `Proxy: ${proxy.note}. Treści z publicznych osadzeń X trafiają prosto do pamięci urządzenia.`
              :
                'Żeby ściągnąć prawdziwe posty w przeglądarce, potrzebny jest serwer proxy (X nie zezwala na CORS). Uruchom `npm run dev:server` albo w Ustawieniach podaj adres własnego proxy. Bez tego działasz na danych demo — pełnia funkcji offline i tak widoczna.'}
            </div>
          </div>
        </div>
      </div>

      <div className="section" style={{ paddingTop: 0 }}>
        <h3 style={{ marginTop: 8 }}>Profile w aplikacji</h3>
        {!accounts.length ? (
          <p className="small dim">Brak zapisanych profili. Poniżej masz zestaw demo do zabawy.</p>
        ) : null}
        <div className="list">
          {(accounts.length ? accounts : demoAccounts.map((a) => ({ ...a, lastSyncAt: null, savedCount: 0 }))).map((a) => (
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
          ))}
        </div>
        {accounts.length ? (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost small grow" onClick={() => fetchMany(accounts.map((a) => a.handle))} disabled={running}>
              <IconRefresh /> Odśwież wszystko
            </button>
            <button className="btn ghost small grow" onClick={() => fetchMany(demoAccounts.map((a) => a.handle))} disabled={running}>
              Dociągnij profile demo
            </button>
          </div>
        ) : null}
      </div>

      <div className="section" style={{ paddingTop: 0 }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>X na żywo (podgląd)</h3>
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
          {blocked ? (
            <div className="frame-fallback">
              <b>Podgląd na żywo wymaga łącza</b>
              <p className="small" style={{ margin: 0 }}>
                {online ?
                  'Ramka z X nie chce się wgrać (blokada osadzania). Nie szkodzi — pobieranie postów idzie własną ścieżką.'
                :
                  'Brak internetu. Otwórz zakładkę „Zapisane” — tam wszystko działa.'}
              </p>
              <p className="tiny" style={{ margin: 0 }}>
                W ustawieniach możesz wpisać własny szablon ramki (np. instancję lustrzaną, którą ufasz).
              </p>
            </div>
          ) : (
            <>
              {frameState === 'loading' ? (
                <div className="frame-fallback" style={{ background: 'transparent' }}>
                  <span className="small dim">wgrywanie podglądu…</span>
                </div>
              ) : null}
              <iframe
                key={`${frameUrl}-${frameKey}`}
                src={frameUrl}
                title={`Podgląd profilu @${handle || 'wybranego'}`}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                onLoad={() => setFrameState('loaded')}
              />
            </>
          )}
        </div>
        <p className="tiny dim" style={{ marginTop: 8 }}>
          Ten iframe to publiczny widok osadzonego timeline X. Nie da się z niego wyciągnąć treści skryptem (inna
          domena) — dlatego przycisk „Pobierz” idzie przez osobny endpoint i zapisuje posty lokalnie.
        </p>
      </div>
    </>
  );
}
