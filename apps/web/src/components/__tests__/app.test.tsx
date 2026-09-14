import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { db } from '@/db/db';
import { ensureDemoSeeded } from '@/lib/demo';
import { useSettings } from '@/lib/store';
import { usePwa } from '@/lib/pwa';

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Blob([new Uint8Array(1024)], { type: 'image/png' }), { status: 200 })),
  );
}

beforeEach(async () => {
  stubFetch();
  usePwa.setState({ needRefresh: false, canInstall: false, offlineReady: true });
  await db.posts.clear();
  await db.blobs.clear();
  await db.accounts.clear();
  await ensureDemoSeeded(true);
  useSettings.setState({
    tab: 'home',
    toasts: [],
    settings: { ...useSettings.getState().settings, sourceMode: 'demo' },
  });
});

describe('szkielet aplikacji', () => {
  it('renderuje nagłówek, cztery zakładki i posty', async () => {
    render(<App />);
    expect(await screen.findByText('X-Offline')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zapisane' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Na żywo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ustawienia' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(5));
  });

  it('przełącza zakładki', async () => {
    render(<App />);
    const user = userEvent.setup();
    await screen.findByText('X-Offline');
    await user.click(screen.getByRole('button', { name: 'Na żywo' }));
    expect(await screen.findByText(/Profile w aplikacji/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisane' }));
    expect(await screen.findByText(/Nie masz jeszcze nic zapisanego/i)).toBeTruthy();
  });

  it('zapisuje post do offline po kliknięciu zakładki', async () => {
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
    const card = document.querySelector('.post') as HTMLElement;
    const save = card.querySelector('.action.save') as HTMLButtonElement;
    await user.click(save);
    await waitFor(async () => expect(await db.posts.where('savedAt').above(0).count()).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(await db.blobs.count()).toBeGreaterThan(0);
  });

  it('ustawienia pokazują tryb źródła i limit miejsca', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ustawienia' }));
    expect(await screen.findByText(/Tylko demo/i)).toBeTruthy();
    expect(await screen.findByText(/Limit offline/i)).toBeTruthy();
    expect(screen.getByText(/bez limitu/)).toBeTruthy();
  });
});
