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
}

/** Zapisuje plik biblioteki: w APK do Documents (potem udostępnianie), w sieci jako zwykły download. */
export async function saveTextFile(name: string, text: string, mime = 'application/json'): Promise<SaveResult> {
  if (isNative()) {
    const written = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Documents, recursive: true });
    try {
      await Share.share({ title: name, url: written.uri ?? name, dialogTitle: 'Wyślij bibliotekę X-Offline' });
    } catch {
      /* użytkownik zamknął udostępnianie — plik i tak zapisany */
    }
    return { where: 'native', path: written.uri ?? `Documents/${name}` };
  }
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
