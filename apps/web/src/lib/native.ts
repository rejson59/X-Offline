/** Mostki natywne: plik biblioteki, przycisk wstecz, cykl życia aplikacji. */
import { App as CapApp } from '@capacitor/app';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './transport';
import { useSettings } from './store';

/** Stos handlerów „wstecz" — najpierw zamykamy overlay'e (reel, sheety), potem wychodzimy z apki. */
const backHandlers: Array<() => boolean> = [];

export function pushBackHandler(fn: () => boolean): () => void {
  backHandlers.push(fn);
  return () => {
    const i = backHandlers.indexOf(fn);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}

export function consumeBack(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    if (backHandlers[i]()) return true;
  }
  return false;
}

export interface SaveResult {
  where: 'native' | 'web';
  path?: string;
  /** Gdzie realnie wylądował plik w APK — zależy od wersji Androida i zgód. */
  label?: string;
}

/** To, czego potrzebujemy od pluginów — wstrzykiwalne, żeby dało się przetestować bez natywu. */
export interface NativeFileIo {
  write(opts: { path: string; data: string; directory: string; recursive: boolean }): Promise<{ uri?: string } | void>;
  share(opts: { title: string; url: string; dialogTitle: string }): Promise<unknown>;
}

const defaultIo: NativeFileIo = {
  write: (opts) => Filesystem.writeFile(opts as Parameters<typeof Filesystem.writeFile>[0]),
  share: (opts) => Share.share(opts),
};

/**
 * Kolejno probowane miejsca zapisu. `Documents` jest publiczne i wygodne (widać plik w menedżerze),
 * ale od Androida 11 apka może w nim pisać tylko tam, gdzie sama coś już stworzyła — więc jak
 * odmówi, spadamy do prywatnego katalogu aplikacji, gdzie zapis zawsze przechodzi.
 */
const NATIVE_TARGETS: Array<{ directory: string; label: string }> = [
  { directory: Directory.Documents, label: 'Documents' },
  { directory: Directory.Data, label: 'katalog aplikacji (Android/data/…)' },
];

/** Zapis w APK: Documents → (gdy odmówi) katalog apki, a do tego próba udostępnienia pliku. */
export async function saveTextFileNative(name: string, text: string, io: NativeFileIo = defaultIo): Promise<SaveResult> {
  let lastError: unknown = null;
  for (const target of NATIVE_TARGETS) {
    try {
      const written = await io.write({ path: name, data: text, directory: target.directory, recursive: true });
      const path = written?.uri ?? `${target.label}/${name}`;
      try {
        await io.share({ title: name, url: path, dialogTitle: 'Wyślij bibliotekę X-Offline' });
      } catch {
        /* użytkownik zamknął udostępnianie — plik i tak zapisany */
      }
      return { where: 'native', path, label: target.label };
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'nieznany błąd');
  throw new Error(`Nie udało się zapisać pliku w pamięci telefonu: ${detail}`);
}

/** Zapis pliku biblioteki: w APK przez saveTextFileNative (Documents → katalog apki), w sieci jako zwykły download. */
export async function saveTextFile(name: string, text: string, mime = 'application/json'): Promise<SaveResult> {
  if (isNative()) return await saveTextFileNative(name, text);
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { where: 'web' };
}

/** Czyta plik wybrany w <input type=file> — wspólna ścieżka dla natywnego i webowego WebView. */
export async function readTextFile(file: File): Promise<string> {
  return await file.text();
}

export function libraryFileName(): string {
  return `xoffline-${new Date().toISOString().slice(0, 10)}.json`;
}

/** Rejestruje nasłuch cyklu życia w APK. W przeglądarce tylko network listeners. */
export function initNativeBridges(onResume?: () => void): void {
  const settings = useSettings.getState();
  if (!isNative()) return;

  void CapApp.addListener('pause', () => settings.toast('Aplikacja w tle — zapisane posty zostają w pamięci', 'info'));
  void CapApp.addListener('resume', () => {
    useSettings.getState().refreshNet();
    onResume?.();
  });
  void CapApp.addListener('backButton', () => {
    if (consumeBack()) return;
    const st = useSettings.getState();
    if (st.tab !== 'home') {
      st.setTab('home');
      return;
    }
    void CapApp.exitApp();
  });
}
