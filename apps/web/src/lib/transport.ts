/**
 * Transport HTTP.
 *
 * Kluczowa decyzja architektoniczna: przeglądarka nie może sama zapytać endpointów
 * syndykacji X (CORS), więc mamy trzy drogi:
 *  1. `native`  — w APK/IPA zapytanie idzie przez CapacitorHttp (sieć natywna, bez CORS),
 *  2. `proxy`   — przez własny serwer (/api/forward), potrzebny w PWA w przeglądarce,
 *  3. `direct`  — próba bezpośredniego fetch() (działa, jeśli serwer X zezwala na CORS).
 *
 * Wszystkie ścieżki mają limit czasu, jedną próbę ponowienia dla błędów przejściowych
 * i wspólny format błędu (`TransportError`), więc UI może powiedzieć *co* poszło nie tak.
 */
import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core';
import { useSettings } from './store';
import { logDiag } from './diagnostics';

export type Transport = 'native' | 'proxy' | 'direct';

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function apiBase(): string {
  const custom = (useSettings.getState().settings.proxyUrl || '').trim().replace(/\/$/, '');
  if (custom) return custom.startsWith('http') ? custom : `${location.origin}${custom.startsWith('/') ? '' : '/'}${custom}`;
  return '';
}

function proxyEnabled(): boolean {
  return useSettings.getState().settings.sourceMode !== 'direct';
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly transport?: Transport,
    /** `true`, gdy ponowienie ma sens (timeout, 5xx, zerwane połączenie). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

function buildProxied(url: string, kind: 'forward' | 'media'): string {
  const base = apiBase();
  return `${base}/api/${kind}?url=${encodeURIComponent(url)}`;
}

/**
 * `AbortSignal.timeout` nie istnieje w starszych WebView (Android 7–10 bez aktualizacji) —
 * bez tego zapytania wisiałyby w nieskończoność i blokowały kolejkę.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const withTimeout = AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
  if (typeof withTimeout.timeout === 'function') {
    try {
      return withTimeout.timeout(ms);
    } catch {
      /* poniżej awaryjna ścieżka */
    }
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return controller.signal;
}

async function nativeRequest(url: string, responseType?: 'blob' | 'text'): Promise<HttpResponse> {
  return CapacitorHttp.get({
    url,
    responseType,
    connectTimeout: 15000,
    readTimeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 XOffline/0.2',
      Accept: responseType === 'blob' ? '*/*' : 'application/json, text/html;q=0.9, */*;q=0.8',
    },
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64.replace(/^data:[^,]+,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function pickTransport(): Transport {
  if (isNative()) return 'native';
  return proxyEnabled() ? 'proxy' : 'direct';
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

async function once(url: string, timeoutMs: number): Promise<string> {
  const transport = pickTransport();
  if (transport === 'native') {
    const res = await nativeRequest(url);
    if (res.status >= 400) {
      throw new TransportError(`HTTP ${res.status}`, res.status, transport, RETRYABLE_STATUS.has(res.status));
    }
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  }
  const target = transport === 'proxy' ? buildProxied(url, 'forward') : url;
  try {
    const res = await fetch(target, { signal: timeoutSignal(timeoutMs), cache: 'no-store' });
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, transport, RETRYABLE_STATUS.has(res.status));
    return await res.text();
  } catch (err) {
    if (transport === 'proxy' && isNetworkError(err)) {
      // Serwer proxy niedostępny — ostatnia próba wprost (czasem X jednak puści CORS).
      const res = await fetch(url, { signal: timeoutSignal(timeoutMs) });
      if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, 'direct');
      return await res.text();
    }
    throw asTransportError(err, transport);
  }
}

/** Tekst/HTML/JSON jako string. Jedno ponowienie dla błędów przejściowych. */
export async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  try {
    return await once(url, timeoutMs);
  } catch (err) {
    const e = asTransportError(err, pickTransport());
    if (!e.retryable) throw e;
    await sleep(600 + Math.random() * 500);
    try {
      return await once(url, timeoutMs);
    } catch (err2) {
      throw asTransportError(err2, pickTransport());
    }
  }
}

export interface BlobResult {
  blob: Blob;
  bytes: number;
  mime: string;
}

/** Pobranie binarki (zdjęcie / wideo) do zrzucenia w IndexedDB. */
export async function fetchBlob(url: string, timeoutMs = 45000): Promise<BlobResult> {
  const transport = pickTransport();
  const isLocal = url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:');
  if (isLocal) {
    const res = await fetch(url, { signal: timeoutSignal(timeoutMs) });
    const blob = await res.blob();
    return { blob, bytes: blob.size, mime: blob.type };
  }
  const attempt = async (): Promise<BlobResult> => {
    if (transport === 'native') {
      const res = await nativeRequest(url, 'blob');
      if (res.status >= 400) {
        throw new TransportError(`HTTP ${res.status}`, res.status, transport, RETRYABLE_STATUS.has(res.status));
      }
      const mime = String(res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? 'image/jpeg');
      const data = res.data;
      const blob =
        typeof data === 'string' ?
          base64ToBlob(data, mime)
        : data instanceof Blob ? data
        : new Blob([data as BlobPart], { type: mime });
      return { blob, bytes: blob.size, mime };
    }
    const target = transport === 'proxy' ? buildProxied(url, 'media') : url;
    try {
      const res = await fetch(target, { signal: timeoutSignal(timeoutMs), mode: 'cors' });
      if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, transport, RETRYABLE_STATUS.has(res.status));
      const blob = await res.blob();
      return { blob, bytes: blob.size, mime: blob.type || guessMime(url) };
    } catch (err) {
      if (transport === 'proxy' && isNetworkError(err)) {
        const res = await fetch(url, { signal: timeoutSignal(timeoutMs), mode: 'cors' });
        const blob = await res.blob();
        return { blob, bytes: blob.size, mime: blob.type || guessMime(url) };
      }
      throw asTransportError(err, transport);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    const e = asTransportError(err, transport);
    if (!e.retryable) throw e;
    await sleep(700 + Math.random() * 600);
    return await attempt();
  }
}

export function guessMime(url: string): string {
  if (/\.mp4(\?|$)/i.test(url)) return 'video/mp4';
  if (/\.webm(\?|$)/i.test(url)) return 'video/webm';
  if (/\.m3u8(\?|$)/i.test(url)) return 'application/x-mpegURL';
  if (/\.gif(\?|$)/i.test(url)) return 'image/gif';
  if (/\.jpe?g(\?|$)/i.test(url)) return 'image/jpeg';
  if (/\.png(\?|$)/i.test(url)) return 'image/png';
  if (/\.svg(\?|$)/i.test(url)) return 'image/svg+xml';
  if (/\.webp(\?|$)/i.test(url)) return 'image/webp';
  return 'application/octet-stream';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /failed to fetch|networkerror|load failed|ERR_|timeout|aborted|abort/i.test(msg);
}

function asTransportError(err: unknown, transport: Transport): TransportError {
  if (err instanceof TransportError) return err;
  const msg = String((err as Error)?.message ?? err);
  const m = msg.match(/HTTP (\d{3})/);
  const status = m ? Number(m[1]) : undefined;
  return new TransportError(msg || 'Błąd sieci', status, transport, status ? RETRYABLE_STATUS.has(status) : isNetworkError(err));
}

/** Czy serwer proxy w ogóle żyje? (decyduje o komunikacie w UI) */
export async function probeProxy(): Promise<{ ok: boolean; upstream?: string; error?: string }> {
  try {
    const res = await fetch(`${apiBase()}/api/health`, { signal: timeoutSignal(4000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; upstream?: string };
    return { ok: Boolean(data.ok), upstream: data.upstream };
  } catch (err) {
    const message = String((err as Error).message ?? err);
    return { ok: false, error: message };
  }
}

/** Loguje nieudane pobranie do dziennika diagnostycznego (raz na dany URL). */
export function noteTransportFailure(where: string, url: string, err: unknown): void {
  const e = asTransportError(err, pickTransport());
  logDiag('warn', `${where}: ${e.message} (${e.transport ?? 'brak'} · ${e.status ?? 'brak kodu'})`, url);
}
