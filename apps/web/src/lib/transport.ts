/**
 * Transport HTTP — tylko do ściągania plików mediów (zdjęcia / klipy) do offline.
 *
 * Posty przychodzą wyłącznie z podglądu X (WebView w APK, patrz `bridge.ts`) —
 * nie ma tu żadnego API ani proxy. Dwie drogi dla binarek:
 *  1. `native` — w APK zapytanie idzie przez CapacitorHttp (sieć natywna, bez CORS),
 *  2. `direct` — zwykły fetch() (CDN X pozwala na CORS dla plików mediów).
 */
import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core';
import { logDiag } from './diagnostics';

export type Transport = 'native' | 'direct';

export function isNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
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

/**
 * `AbortSignal.timeout` nie istnieje w starszych WebView (Android 7–10 bez aktualizacji) —
 * bez tego zapytania wisiałyby w nieskończoność i blokowały zapis.
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

async function nativeRequest(url: string): Promise<HttpResponse> {
  return CapacitorHttp.get({
    url,
    responseType: 'blob',
    connectTimeout: 15000,
    readTimeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 XOffline/0.3',
      Accept: '*/*',
    },
  });
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64.replace(/^data:[^,]+,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface BlobResult {
  blob: Blob;
  bytes: number;
  mime: string;
}

/** Pobranie binarki (zdjęcie / wideo) do zrzucenia w IndexedDB. */
export async function fetchBlob(url: string, timeoutMs = 45000): Promise<BlobResult> {
  const attempt = async (): Promise<BlobResult> => {
    if (isNative()) {
      const res = await nativeRequest(url);
      if (res.status >= 400) {
        throw new TransportError(`HTTP ${res.status}`, res.status, 'native', RETRYABLE_STATUS.has(res.status));
      }
      const mime = String(res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? guessMime(url));
      const data = res.data;
      const blob =
        typeof data === 'string' ?
          base64ToBlob(data, mime)
        : data instanceof Blob ? data
        : new Blob([data as BlobPart], { type: mime });
      return { blob, bytes: blob.size, mime };
    }
    const res = await fetch(url, { signal: timeoutSignal(timeoutMs), mode: 'cors' });
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, 'direct', RETRYABLE_STATUS.has(res.status));
    const blob = await res.blob();
    return { blob, bytes: blob.size, mime: blob.type || guessMime(url) };
  };

  try {
    return await attempt();
  } catch (err) {
    const e = asTransportError(err);
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

function asTransportError(err: unknown): TransportError {
  if (err instanceof TransportError) return err;
  const msg = String((err as Error)?.message ?? err);
  const m = msg.match(/HTTP (\d{3})/);
  const status = m ? Number(m[1]) : undefined;
  const transport: Transport = isNative() ? 'native' : 'direct';
  return new TransportError(msg || 'Błąd sieci', status, transport, status ? RETRYABLE_STATUS.has(status) : isNetworkError(err));
}

/** Loguje nieudane pobranie do dziennika diagnostycznego. */
export function noteTransportFailure(where: string, url: string, err: unknown): void {
  const e = asTransportError(err);
  logDiag('warn', `${where}: ${e.message} (${e.transport ?? 'brak'} · ${e.status ?? 'brak kodu'})`, url);
}
