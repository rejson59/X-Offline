/**
 * Transport HTTP.
 *
 * Kluczowa decyzja architektoniczna: przeglądarka nie może sama zapytać endpointów
 * syndykacji X (CORS), więc mamy trzy drogi:
 *  1. `native`  — w APK/IPA zapytanie idzie przez CapacitorHttp (sieć natywna, bez CORS),
 *  2. `proxy`   — przez własny serwer (/api/forward), potrzebny w PWA w przeglądarce,
 *  3. `direct`  — próba bezpośredniego fetch() (działa, jeśli serwer X zezwala na CORS
 *                albo użytkownik ma wyłączoną kontrolę CORS); kończy się błędem → fallback do demo.
 */
import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core';
import { useSettings } from './store';

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
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

function buildProxied(url: string, kind: 'forward' | 'media'): string {
  const base = apiBase();
  return `${base}/api/${kind}?url=${encodeURIComponent(url)}`;
}

async function nativeRequest(url: string, responseType?: 'blob' | 'text'): Promise<HttpResponse> {
  return CapacitorHttp.get({
    url,
    responseType,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 XOffline/0.1',
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

/** Tekst/HTML/JSON jako string. */
export async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const transport = pickTransport();
  try {
    if (transport === 'native') {
      const res = await nativeRequest(url);
      if (res.status >= 400) throw new TransportError(`HTTP ${res.status}`, res.status, transport);
      return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    }
    const target = transport === 'proxy' ? buildProxied(url, 'forward') : url;
    const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, transport);
    return await res.text();
  } catch (err) {
    if (transport === 'proxy' && isNetworkError(err)) {
      // Serwer proxy niedostępny — ostatnia próba wprost.
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, 'direct');
        return await res.text();
      } catch (e2) {
        throw asTransportError(e2, 'direct');
      }
    }
    throw asTransportError(err, transport);
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
    const res = await fetch(url);
    const blob = await res.blob();
    return { blob, bytes: blob.size, mime: blob.type };
  }
  try {
    if (transport === 'native') {
      const res = await nativeRequest(url, 'blob');
      if (res.status >= 400) throw new TransportError(`HTTP ${res.status}`, res.status, transport);
      const mime = String(res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? 'image/jpeg');
      const data = res.data;
      const blob =
        typeof data === 'string' ?
          base64ToBlob(data, mime)
        : data instanceof Blob ?
          data
        : new Blob([data as BlobPart], { type: mime });
      return { blob, bytes: blob.size, mime };
    }
    const target = transport === 'proxy' ? buildProxied(url, 'media') : url;
    const res = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new TransportError(`HTTP ${res.status}`, res.status, transport);
    const blob = await res.blob();
    return { blob, bytes: blob.size, mime: blob.type || guessMime(url) };
  } catch (err) {
    if (transport === 'proxy' && isNetworkError(err)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), mode: 'cors' });
        const blob = await res.blob();
        return { blob, bytes: blob.size, mime: blob.type || guessMime(url) };
      } catch (e2) {
        throw asTransportError(e2, 'direct');
      }
    }
    throw asTransportError(err, transport);
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

function isNetworkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /failed to fetch|networkerror|load failed|ERR_|timeout|aborted/i.test(msg);
}

function asTransportError(err: unknown, transport: Transport): TransportError {
  if (err instanceof TransportError) return err;
  const msg = String((err as Error)?.message ?? err);
  const m = msg.match(/HTTP (\d{3})/);
  return new TransportError(msg || 'Błąd sieci', m ? Number(m[1]) : undefined, transport);
}

/** Czy serwer proxy w ogóle żyje? (decyduje o komunikacie w UI) */
export async function probeProxy(): Promise<{ ok: boolean; upstream?: string; error?: string }> {
  try {
    const res = await fetch(`${apiBase()}/api/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { ok?: boolean; upstream?: string };
    return { ok: Boolean(data.ok), upstream: data.upstream };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}
