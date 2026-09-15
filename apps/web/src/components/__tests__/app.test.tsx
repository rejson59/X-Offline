import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    tab: 'home',
    toasts: [],
    online: true,
    settings: { ...useSettings.getState().settings, sourceMode: 'auto', reelMode: false, storageCapMb: 0, persistStorage: false },
  });
});

describe('szkielet aplikacji', () => {
  it('renderuje nagłówek, cztery zakładki i zapisane posty', async () => {
    await seedSavedPost();
    render(<App />);
    expect(await screen.findByText('X-Offline')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zapisane' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Na żywo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ustawienia' })).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
  });

  it('na pustej bazie pokazuje instrukcję, a nie sztuczne posty', async () => {
    render(<App />);
    expect(await screen.findByText(/Pusto w pamięci/i)).toBeTruthy();
    expect(document.querySelectorAll('.post')).toHaveLength(0);
    expect(await db.posts.count()).toBe(0);
  });

  it('przełącza zakładki', async () => {
    await seedSavedPost();
    render(<App />);
    const user = userEvent.setup();
    await screen.findByText('X-Offline');
    await user.click(screen.getByRole('button', { name: 'Na żywo' }));
    expect(await screen.findByText(/Automatyczny offline/i)).toBeTruthy();
    expect(screen.getByText(/Profile, które śledzimy/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisane' }));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
  });

  it('zapisuje i usuwa post z offline', async () => {
    const post = makePost({ text: 'Post do zapisania' });
    await db.posts.put(post);
    render(<App />);
    const user = userEvent.setup();
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));

    const card = document.querySelector('.post') as HTMLElement;
    await user.click(card.querySelector('.action.save') as HTMLButtonElement);
    await waitFor(async () => expect(await db.posts.where('savedAt').above(0).count()).toBe(1), { timeout: 8000 });

    // Drugie kliknięcie dopiero, gdy kafel skończył zapisywanie (w trakcie przycisk jest zajęty).
    const savedCard = document.querySelector('.post') as HTMLElement;
    const saveBtn = savedCard.querySelector('.action.save') as HTMLButtonElement;
    await waitFor(() => expect(saveBtn.classList.contains('busy')).toBe(false), { timeout: 8000 });
    await user.click(saveBtn);
    await waitFor(async () => expect(await db.posts.where('savedAt').above(0).count()).toBe(0), { timeout: 8000 });
  }, 20000);

  it('pokazuje licznik nieprzeczytanych na zakładce „Zapisane”', async () => {
    await seedSavedPost({ text: 'nieprzeczytany' });
    const read = await seedSavedPost({ text: 'już przeczytany' });
    await db.posts.update(read.id, { readAt: Date.now() });

    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Główna nawigacja' });
    await waitFor(() => expect(nav.querySelector('.badge-count')?.textContent).toBe('1'), { timeout: 5000 });
    // Sam licznik znika, gdy wszystko przeczytane.
    const rows = await db.posts.where('savedAt').above(0).toArray();
    await Promise.all(rows.map((r) => db.posts.update(r.id, { readAt: Date.now() })));
    await waitFor(() => expect(nav.querySelector('.badge-count')).toBeNull(), { timeout: 5000 });
  });

  it('ustawienia pokazują tryb źródła (bez trybu demo) i limit miejsca', async () => {
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ustawienia' }));
    expect(await screen.findByText(/Limit offline/i)).toBeTruthy();
    expect(screen.getByText(/bez limitu/)).toBeTruthy();
    expect(screen.queryByText(/Tylko demo/i)).toBeNull();
    expect(screen.getByText(/^Auto$/)).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Diagnostyka', level: 2 })).toBeTruthy();
  });
});

describe('regresje (to wywalało apkę)', () => {
  it('filtr „Z kolejki akcji” nie wysypuje interfejsu', async () => {
    const post = await seedSavedPost();
    await db.actions.add({
      kind: 'like',
      tweetId: post.nativeId,
      postId: post.id,
      authorHandle: post.authorHandle,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      origin: 'offline-reader',
    });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zapisane' }));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBeGreaterThan(0));
    await user.click(await screen.findByText('Z kolejki akcji'));
    // Przed poprawką: ReferenceError „Cannot access 'queuedIds' before initialization”
    // i React odmontowywał całe drzewo (biały ekran w APK).
    expect(document.querySelectorAll('.post').length).toBe(1);
    expect(screen.queryByText(/Coś się wysypało/i)).toBeNull();
  });

  it('szukanie i sortowanie nie psują listy', async () => {
    await seedSavedPost({ text: 'Tramwaje nocne wracają na trasę', authorHandle: 'kt_zabrze' });
    await seedSavedPost({ text: 'Koncert w parku', authorHandle: 'miasto_pl' });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zapisane' }));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));

    await user.type(screen.getByPlaceholderText(/Szukaj w zapisanych/i), 'koncert');
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(1));

    await user.clear(screen.getByPlaceholderText(/Szukaj w zapisanych/i));
    await user.click(await screen.findByText('Po autorze'));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));
  });

  it('oznaczanie jako przeczytane działa z paska wyboru', async () => {
    const a = await seedSavedPost({ text: 'pierwszy' });
    await seedSavedPost({ text: 'drugi' });
    render(<App />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Zapisane' }));
    await waitFor(() => expect(document.querySelectorAll('.post').length).toBe(2));

    await user.click(screen.getByRole('button', { name: 'Wybierz wiele' }));
    await user.click(await screen.findByText(/Zaznacz widoczne/));
    await user.click(await screen.findByRole('button', { name: /Przeczytane/ }));
    await waitFor(async () => expect((await db.posts.get(a.id))?.readAt).toBeGreaterThan(0), { timeout: 5000 });
  });
});
