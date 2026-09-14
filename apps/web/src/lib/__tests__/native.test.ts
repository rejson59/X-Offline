import { describe, expect, it, vi } from 'vitest';
import { saveTextFileNative } from '../native';

/**
 * Eksport biblioteki w APK. `saveTextFileNative` przyjmuje sterowane wejście (io), więc
 * tu nie potrzebujemy natywnych pluginów — testujemy samą politykę zapisu.
 */
function ioStub(behaviour: (directory: string) => { uri?: string } | 'fail') {
  const written: Array<{ directory: string; path: string }> = [];
  const shared: string[] = [];
  return {
    written,
    shared,
    io: {
      write: vi.fn(async (opts: { path: string; directory: string }) => {
        const out = behaviour(opts.directory);
        if (out === 'fail') throw new Error(`EACCES: ${opts.directory}`);
        written.push({ directory: opts.directory, path: opts.path });
        return out;
      }),
      share: vi.fn(async (opts: { url: string }) => {
        shared.push(opts.url);
      }),
    },
  };
}

describe('saveTextFileNative', () => {
  it('pisze do publicznego Documents, gdy Android pozwala', async () => {
    const stub = ioStub(() => ({ uri: 'file:///storage/emulated/0/Documents/xoffline.json' }));
    const res = await saveTextFileNative('xoffline.json', '{}', stub.io);

    expect(res.where).toBe('native');
    expect(res.label).toBe('Documents');
    expect(stub.written.map((w) => w.directory)).toEqual(['DOCUMENTS']);
    expect(stub.shared).toEqual(['file:///storage/emulated/0/Documents/xoffline.json']);
  });

  it('spada do prywatnego katalogu apki, gdy Documents odmówi (Android 11+ bez zgód)', async () => {
    const stub = ioStub((directory) => (directory === 'DOCUMENTS' ? 'fail' : { uri: `file:///data/user/0/app.xoffline.mobile/files/${directory}/biblioteka.json` }));
    const res = await saveTextFileNative('biblioteka.json', '{}', stub.io);

    expect(stub.written.map((w) => w.directory)).toEqual(['DATA']);
    expect(res.label).toContain('katalog aplikacji');
    expect(res.path).toContain('biblioteka.json');
  });

  it('udostępnia plik z tego miejsca, do którego faktycznie zapisał', async () => {
    const stub = ioStub((directory) => (directory === 'DOCUMENTS' ? 'fail' : { uri: 'file:///data/user/0/app.xoffline.mobile/files/x.json' }));
    await saveTextFileNative('x.json', '{}', stub.io);

    expect(stub.shared).toHaveLength(1);
    expect(stub.shared[0]).toContain('app.xoffline.mobile');
  });

  it('zapis pozostaje udany, gdy użytkownik zamknie okno udostępniania', async () => {
    const stub = ioStub(() => ({ uri: 'file:///x.json' }));
    stub.io.share = vi.fn(async () => {
      throw new Error('User closed the share sheet');
    }) as never;

    const res = await saveTextFileNative('x.json', '{}', stub.io as never);
    expect(res.where).toBe('native');
    expect(res.path).toBe('file:///x.json');
  });

  it('mówi wprost co poszło nie tak, gdy oba miejsca odmówią', async () => {
    const stub = ioStub(() => 'fail');
    await expect(saveTextFileNative('x.json', '{}', stub.io)).rejects.toThrow(/Nie udało się zapisać pliku w pamięci telefonu/);
    expect(stub.written).toHaveLength(0);
  });
});
