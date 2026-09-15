import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '@/App';
import { db } from '@/db/db';
import { useSettings } from '@/lib/store';
import { usePwa } from '@/lib/pwa';
import { makePost } from '@/lib/__tests__/helpers';
import type { PostRecord } from '@/lib/types';

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(1024), { status: 200, headers: { 'content-type': 'image/png' } })),
  );
}

/** Post z realnego pobrania — trafia do bazy i od razu jest zapisany offline. */
async function seedSavedPost(over: Partial<PostRecord> = {}): Promise<PostRecord> {
  const post = makePost({
    text: 'Prawdziwy post z X o tramwajach w Zabrzu #komunikacja',
    savedAt: Date.now(),
    sizeBytes: 0,
    ...over,
  });
  await db.posts.put(post);
  return post;
}

beforeEach(async () => {
  stubFetch();
  usePwa.setState({ needRefresh: false, canInstall: false, offlineReady: true });
  await db.posts.clear();
  await db.blobs.clear();
  await db.accounts.clear();
  await db.actions.clear();
  useSettings.setState({
    tab: 'feed',
    toasts: [],
    online: true,
    settings: { ...useSettings.getState().settings, reelMode: false, storageCapMb: 0, persistStorage: false },
  });
});

describe('szkielet aplikacji', () => {
  it('renderuje nagłówek, trzy zakładki i zapisane posty', async () => {
    await seedSavedPost();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Zapisane' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' });
    expect(within(nav).getByRole('button', { name: 'Zapisane' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'X' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Ustawienia' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
  });

  it('na pustej bazie pokazuje instrukcję, a nie sztuczne posty', async () => {
    render(<App />);
    expect(await screen.findByText(/Tu będzie Twoja kolejka do czytania/i)).toBeTruthy();
    expect(document.querySelectorAll('.post')).toHaveLength(0);
    expect(await db.posts.count()).toBe(0);
  });

  it('przełącza zakładki', async () => {
    await seedSavedPost();
    render(<App />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Zapisane' });
    await user.click(screen.getByRole('button', { name: 'X' }));
    expect(await screen.findByText(/Przeglądaj X jak zwykle/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ustawienia' }));
    expect(await screen.findByText('Miejsce')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisane' }));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
  });

  it('usuwa post z offline jednym stuknięciem', async () => {
    await seedSavedPost();
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(1));

    const card = document.querySelector('.post') as HTMLElement;
    await user.click(card.querySelector('.action.save') as HTMLButtonElement);
    await waitFor(async () => expect(await db.posts.where('savedAt').above(0).count()).toBe(0), { timeout: 8000 });
    expect(await screen.findByText(/Tu będzie Twoja kolejka do czytania/i)).toBeTruthy();
  }, 20000);

  it('pokazuje licznik nieprzeczytanych na zakładce „Zapisane”', async () => {
    await seedSavedPost({ text: 'nieprzeczytany' });
    const read = await seedSavedPost({ text: 'już przeczytany' });
    await db.posts.update(read.id, { readAt: Date.now() });

    render(<App />);
    const user = userEvent.setup();
    // Licznik widać, gdy nie patrzymy na listę.
    await user.click(await screen.findByRole('button', { name: 'X' }));
    const nav = await screen.findByRole('navigation', { name: 'Główna nawigacja' });
    await waitFor(() => expect(nav.querySelector('.badge-count')?.textContent).toBe('1'), { timeout: 5000 });
    // Sam licznik znika, gdy wszystko przeczytane.
    const rows = await db.posts.where('savedAt').above(0).toArray();
    await Promise.all(rows.map((r) => db.posts.update(r.id, { readAt: Date.now() })));
    await waitFor(() => expect(nav.querySelector('.badge-count')).toBeNull(), { timeout: 5000 });
  });

  it('ustawienia są minimalistyczne: miejsce i czytanie, bez proxy i trybów źródła', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ustawienia' }));
    expect(await screen.findByText('Miejsce')).toBeTruthy();
    expect(screen.getByText(/bez limitu/)).toBeTruthy();
    expect(screen.getByText('Czytanie')).toBeTruthy();
    expect(screen.queryByText(/proxy/i)).toBeNull();
    expect(screen.queryByText(/Tryb pracy/)).toBeNull();
    expect(screen.queryByText(/Tylko demo/i)).toBeNull();
    expect(screen.getByText(/Zaawansowane/)).toBeTruthy();
  });

  it('zakładka X nie ma profili ani ramek — tylko podgląd i zbieranie', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'X' }));
    expect(await screen.findByText(/Przeglądaj X jak zwykle/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Otwórz X' })).toBeTruthy();
    expect(screen.queryByText(/Profile, które śledzimy/i)).toBeNull();
    expect(screen.queryByText(/Podgląd w ramce/i)).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('lista zapisanych', () => {
  it('szukanie filtruje listę', async () => {
    await seedSavedPost({ text: 'Tramwaje nocne wracają na trasę', authorHandle: 'kt_zabrze' });
    await seedSavedPost({ text: 'Koncert w parku', authorHandle: 'miasto_pl' });
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));

    await user.type(screen.getByPlaceholderText(/Szukaj/i), 'koncert');
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(1));

    await user.clear(screen.getByPlaceholderText(/Szukaj/i));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));
  });

  it('filtr nieprzeczytanych i zbiorcze oznaczanie działają', async () => {
    const a = await seedSavedPost({ text: 'pierwszy' });
    await seedSavedPost({ text: 'drugi' });
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));

    await user.click(await screen.findByRole('button', { name: /Nieprzeczytane/ }));
    await user.click(await screen.findByRole('button', { name: /Oznacz wszystkie jako przeczytane/ }));
    await waitFor(async () => expect((await db.posts.get(a.id))?.readAt).toBeGreaterThan(0), { timeout: 5000 });
  });

  it('polubienie z listy dokłada akcję do kolejki', async () => {
    const post = await seedSavedPost({ text: 'do polubienia' });
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(1));

    const card = document.querySelector('.post') as HTMLElement;
    await user.click(card.querySelector('.action.like') as HTMLButtonElement);
    await waitFor(async () => expect((await db.posts.get(post.id))?.xLiked).toBe(true), { timeout: 5000 });
    expect(await db.actions.count()).toBe(1);
  });
});
