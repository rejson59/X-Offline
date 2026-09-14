import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useSettings } from '@/lib/store';
import { useQueue } from '@/lib/download';
import { estimateStorage, pruneToCap, revokeAllObjectUrls } from '@/lib/media';
import { exportLibrary, importLibrary, unsavePosts } from '@/lib/posts';
import { libraryFileName, saveTextFile } from '@/lib/native';
import { resetDemo, demoGeneratedAt } from '@/lib/demo';
import { isNative, probeProxy } from '@/lib/transport';
import { bytesLabel, plural } from '@/lib/format';
import { Sheet } from './Sheets';
import { IconCheck, IconClose, IconDownload, IconRefresh } from './Icons';
import type { Settings } from '@/lib/types';

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="list-item">
      <div className="grow">
        <div className="small"><b>{label}</b></div>
        {hint ? <div className="tiny dim">{hint}</div> : null}
      </div>
      <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}

const CAPS = [0, 64, 128, 256, 512, 1024];

export function SettingsTab() {
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const toast = useSettings((s) => s.toast);
  const netInfo = useSettings((s) => s.netInfo);
  const link = useSettings((s) => s.link);
  const refreshTotals = useQueue((s) => s.refreshTotals);
  const savedCount = useQueue((s) => s.savedCount);
  const totalBytes = useQueue((s) => s.totalBytes);
  const [proxy, setProxy] = useState<{ ok: boolean; note: string }>({ ok: false, note: '—' });
  const [sheet, setSheet] = useState<null | 'reset' | 'clear'>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const storage = useLiveQuery(() => estimateStorage(), [], { usage: 0, quota: 0 });
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], []);
  const jobs = useLiveQuery(() => db.jobs.orderBy('createdAt').reverse().limit(8).toArray(), [], []);

  useEffect(() => {
    void probeProxy().then((r) =>
      setProxy({
        ok: r.ok,
        note: r.ok ? `ok · upstream ${r.upstream ?? '?'}` : (r.error ?? 'brak odpowiedzi'),
      }),
    );
  }, [settings.proxyUrl]);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    patch({ [key]: value } as Partial<Settings>);
  }

  return (
    <div className="section">
      <h2>Tryb pracy</h2>
      <p className="lede">
        X-Offline nie używa płatnego API. Treści czytamy z publicznych endpointów osadzeń (takich, jakich używają
        widgety tweetów), a potem trzymamy je w pamięci urządzenia.
      </p>
      <div className="list" style={{ marginTop: 10 }}>
        {(
          [
            ['auto', 'Auto', 'Natywnie bez proxy, w przeglądarce przez proxy, a jak nic nie wyjdzie — dane demo.'],
            ['demo', 'Tylko demo', 'Zero zapytań sieciowych. Idealne do sprawdzania działania offline.'],
            ['proxy', 'Tylko proxy', 'Wymaga działającego serwera proxy (npm run start:server albo własny adres).'],
            ['direct', 'Wprost z przeglądarki', 'Próba fetch() do X bez proxy. Zwykle blokuje to CORS — test dla upartych.'],
          ] as [Settings['sourceMode'], string, string][]
        ).map(([id, name, hint]) => (
          <button
            key={id}
            className="list-item button"
            onClick={() => {
              set('sourceMode', id);
              toast(`Źródło: ${name.toLowerCase()}`, 'info');
            }}
            style={{ background: settings.sourceMode === id ? 'rgba(29,155,240,.1)' : undefined }}
          >
            <div className="grow">
              <div className="small"><b>{name}</b></div>
              <div className="tiny dim">{hint}</div>
            </div>
            {settings.sourceMode === id ? <IconCheck style={{ color: 'var(--accent)' }} /> : null}
          </button>
        ))}
      </div>

      <h3>Adres proxy</h3>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="field grow"
          placeholder={isNative() ? 'niepotrzebne w APK' : 'https://xoffline-proxy.nazwa.pracownika.workers.dev'}
          value={settings.proxyUrl}
          onChange={(e) => set('proxyUrl', e.target.value.trim())}
        />
        <button
          className="btn ghost small"
          onClick={() =>
            void probeProxy().then((r) => {
              setProxy({ ok: r.ok, note: r.ok ? 'ok' : (r.error ?? 'błąd') });
              toast(r.ok ? 'Proxy odpowiada' : `Proxy: ${r.error ?? 'brak odpowiedzi'}`, r.ok ? 'ok' : 'error');
            })
          }
        >
          <IconRefresh /> Test
        </button>
      </div>
      <div className="tiny dim" style={{ marginTop: 6 }}>
        status: <span className={proxy.ok ? '' : 'dim'}>{proxy.note}</span>
        {isNative() ? ' · w tej wersji aplikacji natywnej proxy jest opcjonalne' : ''}
      </div>

      <h2>Miejsce i offline</h2>
      <div className="banner" style={{ marginTop: 0 }}>
        <IconDownload style={{ width: 20, height: 20, flex: 'none', color: 'var(--accent)' }} />
        <div className="grow small">
          <dl className="kv">
            <dt>Zapisane posty</dt>
            <dd>{plural(savedCount, 'post', 'posty', 'postów')}</dd>
            <dt>Media w bazie</dt>
            <dd>{bytesLabel(totalBytes)}</dd>
            <dt>Całkowite zużycie</dt>
            <dd>{bytesLabel(storage.usage)}</dd>
            <dt>Budżet urządzenia</dt>
            <dd>{storage.quota ? bytesLabel(storage.quota) : '—'}</dd>
          </dl>
          {storage.quota ? (
            <div className={`meter${storage.usage / storage.quota > 0.9 ? ' over' : storage.usage / storage.quota > 0.6 ? ' warn' : ''}`} style={{ marginTop: 8 }}>
              <i style={{ width: `${Math.min(100, (storage.usage / storage.quota) * 100)}%` }} />
            </div>
          ) : null}
          <div className="tiny dim" style={{ marginTop: 6 }}>
            Przeglądarka trzyma to w własnej kwocie IndexedDB/Cache API — odinstalowanie apki czyści pamięć.
          </div>
        </div>
      </div>

      <h3>Limit offline</h3>
      <div className="chips" style={{ paddingInline: 0 }}>
        {CAPS.map((cap) => (
          <button key={cap} className="chip" aria-pressed={settings.storageCapMb === cap} onClick={() => set('storageCapMb', cap)}>
            {cap === 0 ? 'bez limitu' : `${cap} MB`}
          </button>
        ))}
      </div>

      <div className="list">
        <Toggle
          label="Auto-czyszczenie przy limicie"
          hint={`Gdy przekroczysz limit, odejmujemy media najstarszych zapisów (zostawiamy ${settings.pruneKeepPosts} najnowszych).`}
          checked={settings.autoPrune}
          onChange={(v) => set('autoPrune', v)}
        />
        <Toggle
          label="Pobieraj wideo"
          hint="Klipy ważą najwięcej. Wyłącz, jeśli masz mały pakiet."
          checked={settings.downloadVideo}
          onChange={(v) => set('downloadVideo', v)}
        />
        <Toggle
          label="Słuchaj „oszczędzania danych” systemu"
          hint="Gdy system zgłasza tryb oszczędzania danych, pomijamy media i zapisujemy sam tekst."
          checked={settings.respectSaveData}
          onChange={(v) => set('respectSaveData', v)}
        />
        <Toggle
          label="Aktualizuj zapisane przy starcie"
          hint="Po otwarciu apki dociąga świeże posty dla profili, które już masz offline."
          checked={settings.autoSyncOnOpen}
          onChange={(v) => set('autoSyncOnOpen', v)}
        />
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn ghost small grow"
          onClick={async () => {
            const res = await pruneToCap(settings.storageCapMb, settings.pruneKeepPosts);
            await refreshTotals();
            toast(res.removed ? `Zwolniono ${res.removed} ${res.removed === 1 ? 'wpis' : 'wpisów'} (${bytesLabel(res.bytes)})` : 'Nie było co sprzątać', 'ok');
          }}
        >
          Zwolnij miejsce teraz
        </button>
        <button
          className="btn ghost small grow"
          onClick={async () => {
            const rows = await db.posts.where('savedAt').above(0).primaryKeys();
            if (!rows.length) return toast('Brak zapisanych postów', 'info');
            const freed = await unsavePosts(rows as string[]);
            await refreshTotals();
            revokeAllObjectUrls();
            toast(`Usunięto wszystko z offline (${bytesLabel(freed)})`, 'warn');
          }}
        >
          Usuń cały offline
        </button>
      </div>

      <h2>Czytanie</h2>
      <div className="list">
        <Toggle
          label="Pionowy czytnik (styl szpulki)"
          hint="Tapnięcie posta otwiera pełnoekranowy widok ze swipe’em w górę/dół."
          checked={settings.reelMode}
          onChange={(v) => set('reelMode', v)}
        />
        <div className="list-item">
          <div className="grow">
            <div className="small"><b>Rozmiar tekstu postu</b></div>
            <div className="tiny dim">{settings.fontSize}px</div>
          </div>
          <input
            type="range"
            min={13}
            max={19}
            step={1}
            value={settings.fontSize}
            onChange={(e) => set('fontSize', Number(e.target.value))}
            style={{ width: 120, accentColor: 'var(--accent)' }}
          />
        </div>
      </div>

      <h3>Szablon podglądu na żywo</h3>
      <input
        className="field"
        value={settings.liveFrameTemplate}
        onChange={(e) => set('liveFrameTemplate', e.target.value)}
        placeholder="https://…/{handle}"
      />
      <p className="tiny dim" style={{ marginTop: 6 }}>
        <code>{'{handle}'}</code> zastępowane nazwą profilu. Możesz tu wpisać dowolną stronę, którą da się osadzić
        (np. instancję lustrzaną, której ufasz).
      </p>

      <h2>Biblioteka</h2>
      <div className="list">
        <div className="list-item">
          <div className="grow">
            <div className="small"><b>Eksport offline</b></div>
            <div className="tiny dim">Plik .json z zapisanymi postami — przeniesiesz go na inny telefon.</div>
          </div>
          <button
            className="btn ghost small"
            onClick={async () => {
              const lib = await exportLibrary();
              if (!lib.posts.length) return toast('Nie ma czego eksportować', 'warn');
              const res = await saveTextFile(libraryFileName(), JSON.stringify(lib, null, 2));
              toast(
                res.where === 'native' ?
                  `Plik w Documents: ${res.path}`
                : `Wyeksportowano ${plural(lib.posts.length, 'post', 'posty', 'postów')}`,
                'ok',
              );
            }}
          >
            Pobierz
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <div className="small"><b>Import biblioteki</b></div>
            <div className="tiny dim">Wczytuje posty z pliku i dociąga brakujące media.</div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const res = await importLibrary(JSON.parse(await file.text()));
                await refreshTotals();
                toast(`Wczytano ${plural(res.posts, 'post', 'posty', 'postów')} (${bytesLabel(res.bytes)})`, 'ok');
              } catch (err) {
                toast(`Import nie wyszedł: ${(err as Error).message}`, 'error');
              } finally {
                e.target.value = '';
              }
            }}
          />
          <button className="btn ghost small" onClick={() => fileRef.current?.click()}>
            Wybierz
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <div className="small"><b>Zestaw demo</b></div>
            <div className="tiny dim">Wygenerowany {new Date(demoGeneratedAt).toLocaleDateString('pl-PL')} — {plural(accounts.length, 'konto', 'konta', 'kontów')} w bazie.</div>
          </div>
          <button className="btn ghost small" onClick={() => setSheet('reset')}>
            Przeładuj
          </button>
        </div>
      </div>

      <h2>Diagnostyka</h2>
      <div className="banner">
        <div className="grow small">
          <dl className="kv">
            <dt>Łącze</dt>
            <dd>{link === 'offline' ? 'offline' : link === 'slow' ? 'słabe' : 'ok'}</dd>
            <dt>effectiveType</dt>
            <dd>{netInfo.effectiveType ?? '—'}</dd>
            <dt>downlink</dt>
            <dd>{netInfo.downlink ? `${netInfo.downlink} Mb/s` : '—'}</dd>
            <dt>rtt</dt>
            <dd>{netInfo.rtt ? `${netInfo.rtt} ms` : '—'}</dd>
            <dt>saveData</dt>
            <dd>{netInfo.saveData ? 'włączone' : 'wyłączone'}</dd>
            <dt>Platforma</dt>
            <dd>{isNative() ? 'natywna (Capacitor)' : 'przeglądarka'}</dd>
            <dt>Ostatnie zadania</dt>
            <dd>{jobs.length ? jobs[0].status : '—'}</dd>
          </dl>
        </div>
      </div>

      {sheet === 'reset' ? (
        <Sheet title="Przeładować zestaw demo?" subtitle="Usunie pobrane media i przywróci 34 posty demonstracyjne." onClose={() => setSheet(null)}>
          <p className="small dim">Twoje własne zapisane posty znikną wraz z nimi — to czysty reset bazy.</p>
          <div className="row">
            <button className="btn ghost grow" onClick={() => setSheet(null)}>
              <IconClose /> Zostań przy moich danych
            </button>
            <button
              className="btn primary grow"
              onClick={async () => {
                const n = await resetDemo();
                await refreshTotals();
                revokeAllObjectUrls();
                setSheet(null);
                toast(`Załadowano ${n} postów demo`, 'ok');
              }}
            >
              Reset
            </button>
          </div>
        </Sheet>
      ) : null}

      <p className="tiny dim" style={{ marginTop: 18 }}>
        X-Offline 0.1.0 · dane demo: {plural(34, 'post', 'posty', 'postów')} · pamięć lokalna (IndexedDB + Cache API) ·
        żadne dane nie opuszczają urządzenia poza pobieraniem publicznych treści X.
      </p>
    </div>
  );
}
