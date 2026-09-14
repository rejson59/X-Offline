import { useEffect, useState } from 'react';
import { pushBackHandler } from '@/lib/native';
import { useSettings } from '@/lib/store';
import { jobHistory, useQueue } from '@/lib/download';
import type { JobRow } from '@/lib/types';
import { bytesLabel } from '@/lib/format';
import { IconClose, IconDownload } from './Icons';

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(
    () =>
      pushBackHandler(() => {
        onClose();
        return true;
      }),
    [onClose],
  );

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" />
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <h4>{title}</h4>
            {subtitle ? <p className="tiny dim" style={{ margin: 0 }}>{subtitle}</p> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Zamknij">
            <IconClose />
          </button>
        </div>
        <div style={{ marginTop: 10 }}>{children}</div>
        {footer ? <div style={{ marginTop: 14 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

/** Pobieranie po linkach (każdy w linii / spacjach). */
export function ImportSheet({ onClose }: { onClose: () => void }) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const enqueueLinks = useQueue((s) => s.enqueueLinks);
  const toast = useSettings((s) => s.toast);
  const links = raw.split(/[\s,;]+/).filter((l) => /\d{15,20}|x\.com|twitter\.com/.test(l));

  async function run() {
    if (!links.length) return;
    setBusy(true);
    const n = await enqueueLinks(links);
    setBusy(false);
    toast(`Dodano ${n} zadani${n === 1 ? 'e' : 'a'} do kolejki`, 'info');
    onClose();
  }

  return (
    <Sheet
      title="Zapisz posty z linków"
      subtitle="Wklej adresy postów (jeden w linii). Działa też dla kont, których nie obserwujesz."
      onClose={onClose}
      footer={
        <div className="row">
          <button className="btn ghost grow" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn primary grow" disabled={!links.length || busy} onClick={run}>
            <IconDownload /> {busy ? 'W kolejce…' : `Pobierz ${links.length || ''}`}
          </button>
        </div>
      }
    >
      <textarea
        className="field"
        autoFocus
        placeholder={'https://x.com/nasa/status/1234567890123456789\nhttps://x.com/elonmusk/status/1585841080431321088'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <p className="tiny dim" style={{ marginTop: 8 }}>
        {links.length ? `${links.length} ${links.length === 1 ? 'poprawny link' : 'poprawne linki'}` : 'Wrzuć linki w formacie x.com/<user>/status/<id>.'}
        {' · '}
        W APK pobieramy od razu; w przeglądarce bez proxy zadanie skończy się wskazówką, co włączyć.
      </p>
    </Sheet>
  );
}

export function QueueSheet({ onClose }: { onClose: () => void }) {
  const [history, setHistory] = useState<JobRow[]>([]);
  useEffect(() => {
    void jobHistory().then(setHistory);
  }, []);
  const tasks = useQueue((s) => s.tasks);
  const cancel = useQueue((s) => s.cancel);
  const cancelAll = useQueue((s) => s.cancelAll);
  const clearFinished = useQueue((s) => s.clearFinished);
  const running = tasks.some((t) => t.status === 'running' || t.status === 'queued');

  return (
    <Sheet
      title="Kolejka pobierania"
      subtitle="Postęp zapisu do pamięci urządzenia. Możesz zamknąć tę planszę — pobieranie leci dalej."
      onClose={onClose}
      footer={
        <div className="row">
          <button className="btn ghost grow" onClick={clearFinished}>
            Wyczyść historię
          </button>
          <button className="btn danger grow" disabled={!running} onClick={cancelAll}>
            Anuluj wszystko
          </button>
        </div>
      }
    >
      {!tasks.length ? <p className="dim small">Brak aktywnych zadań. Wrzuć coś do pobrania z zakładki „Na żywo” albo z linków.</p> : null}

      {history.length ? (
        <>
          <h3 style={{ margin: '16px 0 4px' }}>Historia w tej bazie</h3>
          {history.map((j) => (
            <div className="row tiny dim" key={j.id} style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span className="grow">
                <b className="small" style={{ color: 'var(--text)' }}>{j.label}</b>
                <span> · {new Date(j.createdAt).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
              </span>
              <span>
                {j.status === 'done' ? `✓ ${j.done}` : j.status === 'error' ? `✕ ${j.lastError?.slice(0, 40) ?? 'błąd'}` : j.status}
                {j.bytes ? ` · ${bytesLabel(j.bytes)}` : ''}
              </span>
            </div>
          ))}
        </>
      ) : null}
      {tasks.map((t) => {
        const pct = t.total ? Math.min(100, Math.round((t.done / t.total) * 100)) : 0;
        return (
          <div className="queue-item" key={t.id}>
            <div className="row">
              <div className="grow">
                <b className="small">{t.label}</b>
                <div className="tiny dim">
                  {t.status === 'running' ? `pobieranie ${t.done}/${t.total}` : ''}
                  {t.status === 'queued' ? 'w kolejce' : ''}
                  {t.status === 'done' ? `zapisane: ${t.done} ${bytesLabel(t.bytes) ? `· ${bytesLabel(t.bytes)}` : ''}` : ''}
                  {t.status === 'error' ? 'błąd' : ''}
                  {t.status === 'cancelled' ? 'anulowane' : ''}
                  {t.upstream ? ` · źródło: ${t.upstream}` : ''}
                </div>
              </div>
              {t.status === 'running' || t.status === 'queued' ? (
                <button className="btn ghost small" onClick={() => cancel(t.id)}>
                  Anuluj
                </button>
              ) : null}
            </div>
            <div className="progress">
              <i style={{ width: `${t.status === 'done' ? 100 : pct}%` }} />
            </div>
            {t.errors.length ? (
              <details className="acc" style={{ marginTop: 2 }}>
                <summary className="tiny">
                  {t.errors.length} {t.errors.length === 1 ? 'uwaga' : 'uwag'}
                </summary>
                <pre className="tiny dim" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>
                  {t.errors.join('\n')}
                </pre>
              </details>
            ) : null}
          </div>
        );
      })}
    </Sheet>
  );
}

export function Toasts() {
  const toasts = useSettings((s) => s.toasts);
  const drop = useSettings((s) => s.dropToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <button className={`toast ${t.kind}`} key={t.id} onClick={() => drop(t.id)}>
          <span className="grow" style={{ textAlign: 'left' }}>
            {t.text}
          </span>
          <IconClose style={{ width: 16, height: 16, opacity: 0.6 }} />
        </button>
      ))}
    </div>
  );
}
