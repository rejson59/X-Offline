import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useSettings } from '@/lib/store';
import { ensurePersistentStorage, pruneToCap } from '@/lib/media';
import { exportLibrary, exportMarkdown, fetchMissingMedia, importLibrary, unsavePosts } from '@/lib/posts';
import { diagnosticsToText, logDiag, useDiagnostics } from '@/lib/diagnostics';
import { maybeReplay } from '@/lib/actions';
import { useActionList } from '@/lib/actionsView';
import { libraryFileName, saveTextFile } from '@/lib/native';
import { isNative } from '@/lib/transport';
import { bytesLabel } from '@/lib/format';
import { Sheet } from './Sheets';
import { IconClose, IconDownload, IconTrash } from './Icons';
import type { PostRecord, Settings } from '@/lib/types';

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
        <div className="small">
          <b>{label}</b>
        </div>
        {hint ? <div className="tiny dim">{hint}</div> : null}
      </div>
      <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}

const CAPS = [0, 128, 256, 512];
const PRUNE_KEEP = 300;

export function SettingsTab() {
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const toast = useSettings((s) => s.toast);
  const link = useSettings((s) => s.link);
  const [sheet, setSheet] = useState<null | 'clear' | 'purge'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = useLiveQuery(() => db.posts.where('savedAt').above(0).toArray(), [], [] as PostRecord[]);
  const { stats: actStats } = useActionList();
  const diag = useDiagnostics((s) => s.entries);

  const bytes = saved.reduce((s, p) => s + (p.sizeBytes ?? 0), 0);
  const missingMedia = saved.filter((p) => p.media.some((m) => !m.cached)).length;
  const capBytes = settings.storageCapMb * 1024 * 1024;

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    patch({ [key]: value } as Partial<Settings>);
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diagnosticsToText(diag));
      toast('Dziennik skopiowany', 'ok');
    } catch {
      toast('Nie da się skopiować w tym miejscu', 'warn');
    }
  }

  return (
    <div className="section narrow fade-in">
      <h2>Czytanie</h2>
      <div className="list card">
        <Toggle
          label="Pełnoekranowy czytnik"
          hint="Stuknięcie posta otwiera widok ze swipe'em w górę i w dół."
          checked={settings.reelMode}
          onChange={(v) => set('reelMode', v)}
        />
        <Toggle
          label="Otwarcie posta = przeczytany"
          hint="Posty otwarte w czytniku znikają z „Nieprzeczytanych”."
          checked={settings.markReadOnOpen}
          onChange={(v) => set('markReadOnOpen', v)}
        />
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Rozmiar tekstu</b>
            </div>
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
            aria-label="Rozmiar tekstu"
          />
        </div>
      </div>

      <h2>Miejsce</h2>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small dim">Zajęte przez media</span>
          <span className="small">
            <b>{bytesLabel(bytes)}</b>
            {capBytes ? <span className="dim"> z {bytesLabel(capBytes)}</span> : null}
          </span>
        </div>
        {capBytes ? (
          <div className="progress calm" style={{ marginTop: 8 }}>
            <i style={{ width: `${Math.min(100, Math.round((bytes / capBytes) * 100))}%` }} />
          </div>
        ) : null}
        <div className="chips calm" style={{ marginTop: 10 }}>
          {CAPS.map((cap) => (
            <button
              key={cap}
              className="chip"
              aria-pressed={settings.storageCapMb === cap}
              onClick={() => set('storageCapMb', cap)}
            >
              {cap === 0 ? 'bez limitu' : `${cap} MB`}
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
          <button
            className="btn small quiet grow"
            disabled={busy !== null || !missingMedia}
            onClick={async () => {
              setBusy('media');
              try {
                const out = await fetchMissingMedia();
                toast(out.posts ? `Dociągnięto media (${bytesLabel(out.bytes)})` : 'Wszystko jest już w pamięci', out.posts ? 'ok' : 'info');
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'media' ? 'Dociągam…' : missingMedia ? `Dociągnij media (${missingMedia})` : 'Media kompletne'}
          </button>
          <button
            className="btn small quiet"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('prune');
              try {
                const res = await pruneToCap(settings.storageCapMb, PRUNE_KEEP);
                toast(res.removed ? `Zwolniono ${bytesLabel(res.bytes)} (teksty zostały)` : 'Nie było czego sprzątać', 'ok');
              } finally {
                setBusy(null);
              }
            }}
          >
            Zwolnij miejsce
          </button>
        </div>
      </div>

      <div className="list card">
        <Toggle
          label="Sprzątaj automatycznie"
          hint="Po przekroczeniu limitu usuwamy media najstarszych postów. Teksty zawsze zostają."
          checked={settings.autoPrune}
          onChange={(v) => set('autoPrune', v)}
        />
        <Toggle
          label="Pobieraj wideo"
          hint="Klipy ważą najwięcej — wyłącz przy małym pakiecie."
          checked={settings.downloadVideo}
          onChange={(v) => set('downloadVideo', v)}
        />
        <Toggle
          label="Szanuj oszczędzanie danych"
          hint="Gdy system oszczędza dane, zapisujemy sam tekst."
          checked={settings.respectSaveData}
          onChange={(v) => set('respectSaveData', v)}
        />
        <Toggle
          label="Trwałe miejsce na dane"
          hint="System nie usunie zapisanych postów przy braku miejsca."
          checked={settings.persistStorage}
          onChange={(v) => {
            set('persistStorage', v);
            if (v) void ensurePersistentStorage();
          }}
        />
      </div>

      <h2>Biblioteka</h2>
      <div className="list card">
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Kopia zapasowa</b>
            </div>
            <div className="tiny dim">Plik .json — przeniesiesz go na inny telefon.</div>
          </div>
          <button
            className="btn quiet small"
            onClick={async () => {
              const lib = await exportLibrary();
              if (!lib.posts.length) return toast('Nie ma czego eksportować', 'warn');
              const res = await saveTextFile(libraryFileName(), JSON.stringify(lib, null, 2));
              toast(res.where === 'native' ? `Zapisano — ${res.label ?? 'Documents'}` : 'Pobrano kopię', 'ok');
            }}
          >
            <IconDownload /> Pobierz
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Czytelny eksport</b>
            </div>
            <div className="tiny dim">Plik Markdown do notatnika.</div>
          </div>
          <button
            className="btn quiet small"
            onClick={async () => {
              const md = await exportMarkdown();
              if (!md.posts) return toast('Nie ma czego eksportować', 'warn');
              const res = await saveTextFile(md.name, md.text, 'text/markdown');
              toast(res.where === 'native' ? `Zapisano — ${res.label ?? 'Documents'}` : 'Pobrano plik', 'ok');
            }}
          >
            <IconDownload /> .md
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Wczytaj kopię</b>
            </div>
            <div className="tiny dim">Posty z pliku .json trafiają do offline.</div>
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
                toast(`Wczytano ${res.posts} postów`, 'ok');
              } catch (err) {
                toast(`Import nie wyszedł: ${(err as Error).message}`, 'error');
              } finally {
                e.target.value = '';
              }
            }}
          />
          <button className="btn quiet small" onClick={() => fileRef.current?.click()}>
            Wybierz
          </button>
        </div>
      </div>

      <h2>Aplikacja</h2>
      <div className="list card">
        {actStats.pending > 0 ? (
          <div className="list-item">
            <div className="grow">
              <div className="small">
                <b>Zaległe akcje ({actStats.pending})</b>
              </div>
              <div className="tiny dim">Polubienia i zakładki czekające na wysyłkę do X.</div>
            </div>
            <button
              className="btn quiet small"
              onClick={async () => {
                const r = await maybeReplay();
                toast(r.queued ? `Wysyłam: ${r.queued}` : (r.reason ?? 'Nic nie czeka'), r.queued ? 'ok' : 'info');
              }}
            >
              Wyślij
            </button>
          </div>
        ) : null}
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Wyczyść offline</b>
            </div>
            <div className="tiny dim">Usuwa zapisane posty i media. Ustawienia zostają.</div>
          </div>
          <button className="btn quiet small" onClick={() => setSheet('clear')}>
            <IconTrash /> Wyczyść
          </button>
        </div>
        <div className="list-item">
          <div className="grow">
            <div className="small">
              <b>Zresetuj wszystko</b>
            </div>
            <div className="tiny dim">Czyści posty, media i kolejki. Nieodwracalne.</div>
          </div>
          <button className="btn danger small" onClick={() => setSheet('purge')}>
            <IconTrash /> Reset
          </button>
        </div>
      </div>

      <details className="acc">
        <summary className="tiny dim">Zaawansowane · diagnostyka ({diag.length})</summary>
        <p className="tiny dim">
          {isNative() ? 'Aplikacja natywna' : 'Przeglądarka'} · łącze: {link === 'offline' ? 'brak' : link === 'slow' ? 'słabe' : 'ok'} ·
          zapisane: {saved.length}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn quiet small" onClick={() => void copyDiagnostics()} disabled={!diag.length}>
            Kopiuj dziennik
          </button>
          <button
            className="btn quiet small"
            onClick={() => {
              void useDiagnostics.getState().clear();
              logDiag('info', 'dziennik wyczyszczony');
            }}
          >
            Wyczyść dziennik
          </button>
        </div>
        {diag.slice(0, 6).map((entry, i) => (
          <div className="tiny dim" key={`${entry.at}-${i}`} style={{ marginTop: 4 }}>
            {new Date(entry.at).toLocaleTimeString('pl-PL')} · {entry.text}
          </div>
        ))}
      </details>

      <p className="tiny dim footer-note">X-Offline · posty zapisują się z podglądu X · wszystko zostaje w telefonie</p>

      {sheet === 'clear' ? (
        <Sheet
          title="Wyczyścić offline?"
          subtitle="Zapisane posty i media znikną. Ustawienia zostają."
          onClose={() => setSheet(null)}
          footer={
            <div className="row">
              <button className="btn quiet grow" onClick={() => setSheet(null)}>
                <IconClose /> Zostaw
              </button>
              <button
                className="btn danger grow"
                onClick={async () => {
                  const rows = await db.posts.where('savedAt').above(0).primaryKeys();
                  setSheet(null);
                  if (!rows.length) return toast('Już jest pusto', 'info');
                  const freed = await unsavePosts(rows as string[]);
                  toast(`Wyczyszczono (${bytesLabel(freed)})`, 'info');
                }}
              >
                <IconTrash /> Wyczyść
              </button>
            </div>
          }
        >
          <p className="small dim">Posty wrócą do stanu „tylko online”, a media znikną z pamięci.</p>
        </Sheet>
      ) : null}

      {sheet === 'purge' ? (
        <Sheet
          title="Zresetować apkę?"
          subtitle="Posty, media i kolejki zostaną skasowane."
          onClose={() => setSheet(null)}
          footer={
            <div className="row">
              <button className="btn quiet grow" onClick={() => setSheet(null)}>
                <IconClose /> Zostaw
              </button>
              <button
                className="btn danger grow"
                onClick={async () => {
                  setSheet(null);
                  await Promise.all([db.posts.clear(), db.blobs.clear(), db.actions.clear()]);
                  toast('Apka wyczyszczona', 'info');
                }}
              >
                <IconTrash /> Reset
              </button>
            </div>
          }
        >
          <p className="small dim">Ustawienia (limit miejsca, zbieranie) zostają.</p>
        </Sheet>
      ) : null}
    </div>
  );
}
