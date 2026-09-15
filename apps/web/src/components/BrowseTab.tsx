import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { useSettings } from '@/lib/store';
import { bridge, type LiveStatus } from '@/lib/bridge';
import { isNative } from '@/lib/transport';
import { captureEvents, savedOfflineCount } from '@/lib/capture';
import { maybeReplay } from '@/lib/actions';
import { useActionList } from '@/lib/actionsView';
import { relativeTime } from '@/lib/format';
import { IconQueue, IconX } from './Icons';

const TARGETS = [50, 100, 200, 500];

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="list-item">
      <div className="grow">
        <div className="small">
          <b>{label}</b>
        </div>
        <div className="tiny dim">{hint}</div>
      </div>
      <button className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
    </div>
  );
}

export function BrowseTab() {
  const settings = useSettings((s) => s.settings);
  const patch = useSettings((s) => s.patch);
  const toast = useSettings((s) => s.toast);
  const [live, setLive] = useState<LiveStatus>({ open: false });
  const [saved, setSaved] = useState(0);
  const [events, setEvents] = useState(() => captureEvents());
  const [busy, setBusy] = useState(false);
  const { stats } = useActionList();
  const lastSavedAt = useLiveQuery(async () => {
    const rows = await db.posts.where('savedAt').above(0).toArray();
    return rows.reduce((m, p) => Math.max(m, p.savedAt ?? 0), 0);
  }, []);
  const native = isNative();

  useEffect(() => {
    void savedOfflineCount().then(setSaved);
    if (!native) return;
    void bridge.status().then(setLive);
    const t = window.setInterval(() => {
      void bridge.status().then(setLive);
      void savedOfflineCount().then(setSaved);
      setEvents(captureEvents());
    }, 3000);
    return () => window.clearInterval(t);
  }, [native]);

  async function openX(tab: 'home' | 'bookmarks' = 'home') {
    if (busy) return;
    setBusy(true);
    try {
      const remaining = Math.max(20, settings.autoTarget - saved);
      const res = await bridge.openLive({ tab, autoScroll: settings.autoScroll, maxPosts: remaining });
      if (!res.ok) {
        toast('Podgląd X z logowaniem jest w aplikacji (APK).', 'info');
      } else {
        setLive({ open: true, loggedIn: true });
      }
    } finally {
      setBusy(false);
    }
  }

  async function flushActions() {
    const res = await maybeReplay();
    if (res.queued) toast(`Wysyłam ${res.queued} akcji…`, 'ok');
    else if (res.reason) toast(res.reason, 'info');
    else toast('Nic nie czeka na wysyłkę', 'info');
  }

  const pct = Math.min(100, Math.round((saved / Math.max(1, settings.autoTarget)) * 100));
  const got = live.captured ?? live.collected ?? 0;

  return (
    <div className="section narrow fade-in">
      <div className="hero">
        <span className="hero-mark" aria-hidden>
          <IconX />
        </span>
        <h2>Przeglądaj X jak zwykle</h2>
        <p className="dim small">
          {native
            ? 'Zaloguj się raz w podglądzie. Wszystko, co przewiniesz, zapisze się do czytania bez internetu.'
            : 'Zbieranie działa w aplikacji (APK) — tam podgląd trzyma Twoją sesję X i zapisuje to, co przewijasz.'}
        </p>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary big" onClick={() => void openX('home')} disabled={busy}>
            {busy ? 'Otwieram…' : 'Otwórz X'}
          </button>
          {native ? (
            <button className="btn quiet" onClick={() => void openX('bookmarks')} disabled={busy}>
              Zakładki X
            </button>
          ) : null}
        </div>
        {live.open ? (
          <p className="tiny dim" style={{ margin: '10px 0 0' }}>
            Podgląd otwarty{got ? ` · zebrano ${got}` : ''}{live.scrolling ? ' · przewijam' : ''}
            {live.loggedIn === false ? ' · wygląda na to, że nie jesteś zalogowany' : ''}
          </p>
        ) : null}
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="small dim">Zebrano do offline</span>
          <span className="small">
            <b>{saved}</b> <span className="dim">/ {settings.autoTarget}</span>
          </span>
        </div>
        <div className="progress calm" style={{ marginTop: 8 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="chips calm" style={{ marginTop: 10 }}>
          {TARGETS.map((n) => (
            <button
              key={n}
              className="chip"
              aria-pressed={settings.autoTarget === n}
              onClick={() => patch({ autoTarget: n })}
            >
              {n}
            </button>
          ))}
        </div>
        {lastSavedAt ? (
          <p className="tiny dim" style={{ margin: '8px 0 0' }}>
            Ostatni zapis: {relativeTime(lastSavedAt)}
          </p>
        ) : null}
      </div>

      <div className="list card">
        <ToggleRow
          label="Zapisuj przy przewijaniu"
          hint="Każdy post, który miniesz w podglądzie, ląduje w offline."
          checked={settings.autoCapture}
          onChange={(v) => patch({ autoCapture: v })}
        />
        <ToggleRow
          label="Przewijaj za mnie"
          hint="Apka sama przewija feed, żeby zebrać partię postów."
          checked={settings.autoScroll}
          onChange={(v) => patch({ autoScroll: v })}
        />
        <ToggleRow
          label="Zakładki X też się zapisują"
          hint="To, co zapiszesz w samym X, trafia do offline."
          checked={settings.mirrorBookmarks}
          onChange={(v) => patch({ mirrorBookmarks: v })}
        />
      </div>

      {stats.pending > 0 || stats.error > 0 ? (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small">
              <b>{stats.pending}</b> <span className="dim">akcji czeka na wysyłkę do X</span>
            </span>
            <button className="btn small quiet" onClick={() => void flushActions()}>
              <IconQueue /> Wyślij
            </button>
          </div>
          {stats.error > 0 ? (
            <p className="tiny dim" style={{ margin: '6px 0 0' }}>
              {stats.error} nie udało się wysłać — spróbujemy przy następnej okazji.
            </p>
          ) : null}
        </div>
      ) : null}

      {native && events.length > 0 ? (
        <div className="card subtle">
          <div className="tiny dim" style={{ marginBottom: 4 }}>
            Ostatnie zapisy
          </div>
          {events.slice(0, 3).map((l, i) => (
            <div className="tiny dim" key={`${l.at}-${i}`}>
              {new Date(l.at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} · {l.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
