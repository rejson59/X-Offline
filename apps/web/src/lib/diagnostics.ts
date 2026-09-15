/**
 * Diagnostyka — jedno miejsce, w którym lądują błędy apki (JS i natywne).
 *
 * Po co: „czasami wywala aplikację” bez śladu nie da się naprawić. Tu zbieramy:
 *  - nieobsłużone błędy JS (`error` / `unhandledrejection`) i błędy renderowania Reacta,
 *  - logi z natywnego podglądu X (`captureLog`), w tym komunikaty konsoli strony X,
 *  - własne zdarzenia apki (zapis do offline, migracje, nieudane pobrania).
 *
 * Wpisy trzymamy w pamięci (szybkie UI) i zrzucamy do IndexedDB (`meta: diagnostics`),
 * żeby dało się je pokazać po restarcie apki — i wyeksportować jednym kliknięciem.
 */
import { create } from 'zustand';
import { getMeta, setMeta } from '@/db/db';

export type DiagKind = 'error' | 'warn' | 'info' | 'capture';

export interface DiagEntry {
  at: number;
  kind: DiagKind;
  text: string;
  detail?: string;
  /** Skrót stosu / kontekstu (krótki, żeby nie puchła baza). */
  stack?: string;
}

const MAX_ENTRIES = 200;
const MAX_PERSISTED = 60;
const MAX_TEXT = 400;
const STORE_KEY = 'diagnostics';

interface DiagState {
  entries: DiagEntry[];
  add: (kind: DiagKind, text: string, detail?: string) => void;
  clear: () => Promise<void>;
  hydrate: () => Promise<void>;
}

let persistTimer: number | undefined;

function short(value: unknown, max = MAX_TEXT): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const useDiagnostics = create<DiagState>((set, get) => ({
  entries: [],

  add: (kind, text, detail) => {
    const entry: DiagEntry = {
      at: Date.now(),
      kind,
      text: short(text),
      detail: detail ? short(detail, 800) : undefined,
      stack: detail && /\n\s+at /.test(detail) ? short(detail.split('\n').slice(0, 6).join('\n'), 800) : undefined,
    };
    // Najnowsze na górze; przy powtórzeniach tego samego komunikatu nie zaśmiecamy listy.
    const previous = get().entries;
    if (previous[0]?.text === entry.text && previous[0]?.kind === entry.kind && entry.at - previous[0].at < 1500) {
      return;
    }
    set({ entries: [entry, ...previous].slice(0, MAX_ENTRIES) });
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      void setMeta(STORE_KEY, get().entries.slice(0, MAX_PERSISTED)).catch(() => undefined);
    }, 500);
  },

  clear: async () => {
    set({ entries: [] });
    await setMeta(STORE_KEY, []).catch(() => undefined);
  },

  hydrate: async () => {
    try {
      const stored = await getMeta<DiagEntry[]>(STORE_KEY, []);
      if (Array.isArray(stored) && stored.length) set({ entries: stored.slice(0, MAX_ENTRIES) });
    } catch {
      /* brak bazy = brak historii; sam błąd zgłosi alarm gdzie indziej */
    }
  },
}));

/** Wygodny skrót dla kodu, który nie chce dźwigać hooka. */
export function logDiag(kind: DiagKind, text: string, detail?: string): void {
  useDiagnostics.getState().add(kind, text, detail);
}

export function logError(where: string, err: unknown): void {
  const e = err as Error & { message?: string };
  const message = e?.message ?? String(err);
  logDiag('error', `${where}: ${message}`, e?.stack ?? String(err));
}

/**
 * Podpina globalne łapacze błędów. Wywołane raz na starcie apki.
 *
 * Uwaga: to *nie* ukrywa błędu — nieobsłużony odrzut dalej leci do konsoli, ale zostaje
 * w dzienniku, więc użytkownik może go wysłać/ pokazać, zamiast zgadywać, co się stało.
 */
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    const err = event.error as Error | undefined;
    // Błędy z <img>/<video> (Event bez `error`) pomijamy — to nie awaria apki.
    if (!err && !(event instanceof ErrorEvent)) return;
    logDiag('error', `window.onerror: ${event.message || err?.message || 'nieznany błąd'}`, err?.stack);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason as Error | undefined;
    const message = reason?.message ?? String(reason);
    // Przerwania pobierania (AbortError) to normalna część pracy — nie zaśmiecamy dziennika.
    if (/abort/i.test(message)) return;
    logDiag('error', `nieobsłużony wyjątek: ${message}`, reason?.stack);
  });
}

/** Zrzut dziennika do tekstu (eksport / wklejenie w zgłoszeniu błędu). */
export function diagnosticsToText(entries: DiagEntry[]): string {
  const header = [
    '# X-Offline — dziennik diagnostyczny',
    `wygenerowano: ${new Date().toISOString()}`,
    `platforma: ${navigator.userAgent}`,
    '',
  ].join('\n');
  const body = entries
    .map((e) => {
      const when = new Date(e.at).toISOString();
      const detail = e.detail ? `\n    ${e.detail.replace(/\n/g, '\n    ')}` : '';
      return `[${when}] (${e.kind}) ${e.text}${detail}`;
    })
    .join('\n');
  return `${header}${body}\n`;
}
