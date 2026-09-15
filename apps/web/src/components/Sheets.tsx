import { useEffect, useState } from 'react';
import { pushBackHandler } from '@/lib/native';
import { clearSent, discardAction, maybeReplay } from '@/lib/actions';
import { useActionList } from '@/lib/actionsView';
import { useSettings } from '@/lib/store';
import { isNative } from '@/lib/transport';
import { IconClose, IconExternal } from './Icons';

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
          <IconClose style={{ width: 15, height: 15, opacity: 0.5 }} />
        </button>
      ))}
    </div>
  );
}

/** Akcje kliknięte offline, czekające na wysyłkę do X. */
export function ActionsSheet({ onClose }: { onClose: () => void }) {
  const { rows, stats } = useActionList();
  const [busy, setBusy] = useState(false);
  const toast = useSettings((s) => s.toast);

  const label = (kind: string) =>
    kind === 'like' ? 'Polubienie' : kind === 'unlike' ? 'Cofnięte polubienie' : kind === 'bookmark' ? 'Zakładka' : 'Usunięta zakładka';

  return (
    <Sheet
      title="Do wysłania"
      subtitle="Polubienia i zakładki kliknięte offline. Polecą do X przy najbliższej okazji."
      onClose={onClose}
      footer={
        <div className="row">
          <button
            className="btn quiet grow"
            onClick={async () => {
              const n = await clearSent();
              toast(n ? `Wyczyszczono ${n}` : 'Nie ma wysłanych', 'info');
            }}
          >
            Wyczyść wysłane
          </button>
          <button
            className="btn primary grow"
            disabled={busy || !stats.pending}
            onClick={async () => {
              setBusy(true);
              const res = await maybeReplay();
              setBusy(false);
              toast(
                res.queued ? `Wysyłam: ${res.queued}` : (res.reason ?? 'Nic do wysłania'),
                res.queued ? 'ok' : 'info',
              );
            }}
          >
            {busy ? 'Wysyłam…' : `Wyślij${stats.pending ? ` (${stats.pending})` : ''}`}
          </button>
        </div>
      }
    >
      {!isNative() ? (
        <p className="tiny dim" style={{ marginTop: 0 }}>
          Wysyłka działa w aplikacji (APK), gdzie jest Twoja sesja X. Tutaj kolejka po prostu czeka.
        </p>
      ) : null}

      {!rows.length ? <p className="dim small">Pusto. Wszystko wysłane albo nic nie kliknięte.</p> : null}

      {rows.map((row) => (
        <div className="action-row" key={row.id}>
          <span className={`status-dot ${row.status}`} />
          <div className="grow">
            <div className="small">
              <b>{label(row.kind)}</b>
              {row.authorHandle ? <span className="dim"> · @{row.authorHandle}</span> : null}
            </div>
            {row.snippet ? <div className="tiny dim clamp">{row.snippet}</div> : null}
            {row.error ? <div className="tiny err-text">{row.error}</div> : null}
          </div>
          {row.tweetUrl ? (
            <a className="icon-btn sm" href={row.tweetUrl} target="_blank" rel="noreferrer" aria-label="Otwórz post w X">
              <IconExternal />
            </a>
          ) : null}
          <button
            className="icon-btn sm"
            aria-label="Usuń z kolejki"
            onClick={async () => {
              if (row.id) await discardAction(row.id);
            }}
          >
            <IconClose />
          </button>
        </div>
      ))}
    </Sheet>
  );
}
