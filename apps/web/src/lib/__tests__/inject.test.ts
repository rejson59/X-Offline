import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestTweets } from '../capture';
import { useSettings } from '../store';
import { db } from '@/db/db';

interface Internals {
  isTweetLike(o: unknown): boolean;
  collectCandidates(node: unknown, out: unknown[], depth: number): void;
  sourceFor(url: string): string;
  interesting(url: string): boolean;
  ingestFromJson(text: string, source: string): number;
  state: { collected: number };
}

function loadInject(): Internals {
  const file = join(__dirname, '../../../public/inject/xoffline-capture.js');
  const src = readFileSync(file, 'utf8');
  // host to localhost → skrypt się nie samo-uruchamia, tylko eksponuje wnętrzności
  (window as unknown as { eval: (s: string) => void }).eval(src);
  const internals = (window as unknown as { __xofflineInternals: Internals }).__xofflineInternals;
  expect(internals).toBeTruthy();
  return internals;
}

describe('wstrzykiwany zbieracz (assets/inject/xoffline-capture.js)', () => {
  it('ładuje się w środowisku bez hosta x.com i nie startuje samo', () => {
    const it1 = loadInject();
    expect(it1.state.collected).toBe(0);
    expect(location.hostname).not.toMatch(/x\.com$/);
  });

  it('wykrywa tweeta w każdym z kształtów odpowiedzi', () => {
    const { isTweetLike, collectCandidates } = loadInject();
    const syndication = { id_str: '1', text: 'hej' };
    const graphql = { rest_id: '2', legacy: { full_text: 'siema', favorite_count: 3 } };
    expect(isTweetLike(syndication)).toBe(true);
    expect(isTweetLike(graphql)).toBe(true);
    expect(isTweetLike({ id_str: '3' })).toBe(false);
    expect(isTweetLike(null)).toBe(false);

    const out: unknown[] = [];
    collectCandidates({ data: { timeline: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: graphql } } } }] }] } } }, out, 0);
    expect(out).toHaveLength(1);
  });

  it('filtruje po URL-u tylko odpowiedzi graphql', () => {
    const { interesting, sourceFor } = loadInject();
    expect(interesting('https://x.com/i/api/graphql/abc/TimelineHome')).toBe(true);
    expect(interesting('https://x.com/i/side_effects/foo')).toBe(false);
    expect(sourceFor('https://x.com/i/api/graphql/x/Bookmarks')).toBe('live-scroll');
    expect(sourceFor('https://x.com/i/bookmarks')).toBe('bookmarks-mirror');
  });

  it('policzy nowe posty i nie liczy duplikatów dwa razy', () => {
    const mod = loadInject();
    const payload = JSON.stringify({
      entries: [
        { content: { tweet: { rest_id: '100', legacy: { full_text: 'pierwszy', created_at: 'Tue Sep 01 09:12:00 +0000 2026', user: { screen_name: 'orbita_pl' } } } } },
        { content: { tweet: { rest_id: '101', legacy: { full_text: 'drugi', created_at: 'Tue Sep 01 09:13:00 +0000 2026', user: { screen_name: 'orbita_pl' } } } } },
      ],
    });
    const before = mod.state.collected;
    expect(mod.ingestFromJson(payload, 'live-scroll')).toBe(2);
    expect(mod.ingestFromJson(payload, 'live-scroll')).toBe(0);
    expect(mod.state.collected).toBe(before + 2);
  });

  it('apkowy mostek pakuje { source, tweets } do wspólnej normalizacji', async () => {
    await db.posts.clear();
    useSettings.setState({
      settings: { ...useSettings.getState().settings, autoCapture: true, autoTarget: 50, storageCapMb: 0 },
    });
    const envelope = {
      source: 'bookmarks-mirror',
      collectedAt: Date.now(),
      tweets: [
        {
          rest_id: '555000111222333444',
          core: { user_results: { result: { legacy: { name: 'Orbita', screen_name: 'orbita_pl' } } } },
          legacy: {
            id_str: '555000111222333444',
            full_text: 'Post z zakładek X',
            created_at: 'Tue Sep 01 09:12:00 +0000 2026',
            favorite_count: 4,
            bookmarked: true,
          },
        },
      ],
    };
    const report = await ingestTweets(envelope, { via: 'bookmarks-mirror', source: 'bookmarks-mirror' });
    expect(report.saved).toBe(1);
    const row = await db.posts.get('syndication:555000111222333444');
    expect(row?.text).toBe('Post z zakładek X');
    expect(row?.via).toBe('bookmarks-mirror');
    expect(row?.xBookmarked).toBe(true);
    expect(row?.savedAt).toBeGreaterThan(0);
  });
});
