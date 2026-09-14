#!/usr/bin/env node
/**
 * Generuje zestaw DEMO: obrazy (SVG) + posty (JSON), żeby aplikacja miała co pokazać
 * bez żadnego klucza API i bez internetu (to też dane testowe trybu offline).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = join(root, 'apps/web/public/demo-media');
const fixturesDir = join(root, 'apps/web/src/fixtures');
mkdirSync(mediaDir, { recursive: true });
mkdirSync(fixturesDir, { recursive: true });

const rand = (() => {
  let s = 1337;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (a, b) => a + Math.floor(rand() * (b - a));

function photoSvg(i, { w = 1200, h = 675, title = '', palette }) {
  const [c1, c2, c3] = palette;
  let shapes = '';
  for (let k = 0; k < 9; k++) {
    const cx = int(0, w);
    const cy = int(0, h);
    const r = int(h * 0.04, h * 0.3);
    const o = (0.05 + rand() * 0.25).toFixed(2);
    shapes +=
      k % 3 === 0 ?
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c3}" opacity="${o}"/>`
      : `<rect x="${cx}" y="${cy}" width="${r * 2}" height="${r * 0.7}" rx="${r * 0.3}" fill="#fff" opacity="${(o * 0.6).toFixed(2)}" transform="rotate(${int(-30, 30)} ${cx} ${cy})"/>`;
  }
  const bars = Array.from({ length: 14 }, (_, k) => {
    const bw = w / 22;
    const bh = int(10, h * 0.34);
    return `<rect x="${w * 0.08 + k * bw * 1.5}" y="${h - bh - h * 0.13}" width="${bw}" height="${bh}" rx="${bw / 2.4}" fill="#fff" opacity="0.55"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${c1}"/><stop offset=".55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
</linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>${shapes}
<g opacity=".9">${title ? bars : ''}</g>
<text x="${w * 0.08}" y="${h * 0.16}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="${Math.round(h * 0.075)}" font-weight="700" fill="#fff" opacity=".95">${title}</text>
<text x="${w * 0.08}" y="${h * 0.9}" font-family="system-ui,sans-serif" font-size="${Math.round(h * 0.04)}" fill="#fff" opacity=".7">demo-img-${String(i).padStart(2, '0')} · zapisane lokalnie</text>
</svg>`;
}

function clipSvg(i, { w = 720, h = 1280, palette, label }) {
  const [c1, c2, c3] = palette;
  const blobs = Array.from({ length: 5 }, (_, k) => {
    const dur = int(2600, 5200);
    return `<circle cx="${int(w * 0.2, w * 0.8)}" cy="${int(h * 0.25, h * 0.75)}" r="${int(60, 210)}" fill="${c3}" opacity="0.${int(12, 36)}">
<animate attributeName="cx" values="${int(0, w)};${int(0, w)};${int(0, w)}" dur="${dur}ms" repeatCount="indefinite"/>
<animate attributeName="cy" values="${int(0, h)};${int(0, h)};${int(0, h)}" dur="${dur * 1.3}ms" repeatCount="indefinite"/>
</circle>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2=".6" y2="1">
<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>${blobs}
<rect x="${w * 0.06}" y="${h * 0.42}" width="${w * 0.88}" height="${h * 0.13}" rx="26" fill="#000" opacity=".42"/>
<text x="${w / 2}" y="${h * 0.5}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${Math.round(w * 0.072)}" font-weight="800" fill="#fff">${label}</text>
<g><rect x="${w * 0.06}" y="${h * 0.93}" width="${w * 0.88}" height="8" rx="4" fill="#fff" opacity=".25">
<animate attributeName="opacity" values=".25;.6;.25" dur="2.2s" repeatCount="indefinite"/></rect></g>
</svg>`;
}

const palettes = [
  ['#0a1a2f', '#123a63', '#38c3f4'],
  ['#1a0a2f', '#4b1263', '#f45ac3'],
  ['#04231c', '#0c5544', '#2fd6a3'],
  ['#2f1704', '#7a3d0a', '#ffb347'],
  ['#200404', '#6b0f1a', '#ff5c7a'],
  ['#0d0d12', '#2b2d42', '#8d99ae'],
  ['#10243a', '#1f4068', '#7de2fc'],
  ['#160f2e', '#3a2b7a', '#a78bfa'],
];

const accounts = [
  { handle: 'kasia_koduje', name: 'Kasia Nowak', bio: 'frontend + offline-first' },
  { handle: 'silesia_dev', name: 'Śląsk Dev', bio: 'społeczność' },
  { handle: 'orbita_pl', name: 'Orbita', bio: 'nauka prosto' },
  { handle: 'foto_wegierek', name: 'M. Węgierek', bio: 'fotografia' },
  { handle: 'low_bitrate', name: 'Low Bitrate', bio: 'sieci na wsi' },
  { handle: 'x_offline', name: 'X-Offline', bio: 'konto projektu' },
];

const texts = [
  'Trzy lata próbowania i w końcu: whole timeline działa w samolocie.Sekret? Media lądują w IndexedDB, zanim stracę zasięg.',
  'Tip dla osób piszących apkę mobilną: nie walcz z CORS-em w przeglądarce. W natywnym buildzie zapytanie idzie przez CapacitorHttp i nikt ci nie blokuje.',
  'Zrobiłem licznik zajętości offline-cache. Limit 256 MB trzyma mnie przed zamienieniem telefonu w śmietnik.',
  'Najczęstszy błąd w trybie offline: zakładamy, że „brak internetu” to stan, a to przecież widmo. 1 bar LTE, 30% pakietu, zero cierpliwości.',
  'Kto potrzebuje 4K do obejrzenia posta na telefonie? Nikt. Wariant 832 kbps wygląda identycznie i waży 6x mniej.',
  'Wieczorny ranking czytników offline: 1. nasz, 2. nasz, 3. aplikacja, która kasuje cache przy aktualizacji.',
  'Słabe łącze to nie brak łącza. Cache pierwszeństwa + retry z jitterem = da się żyć.',
  'Czytnik bez internetu powinien działać jak kartka: zero spinnera, zero „coś poszło nie tak”.',
  'Cache media to połowa roboty. Druga połowa: powiedzieć użytkownikowi, ile to zajmie i dać mu przycisk Anuluj.',
  'Fotki z Zabrza o 6 rano. Miejsce, w którym zasięg jest legendą miejską — idealny test naszego trybu offline.',
  'Drobna zmiana: zapis postu nie pobiera już odpowiedzi. Mniej bajtów, szybciej, czyta się lepiej.',
  'Zapisywanie przez udostępnianie działa: w X klikasz Udostępnij → X-Offline → post wskakuje do kolejki.',
  'Jak dla mnie najlepsze w tej apce: licznik u góry mówi „masz 148 postów, 190 MB”. Wiesz, na co Ci wystarczy w pociągu.',
  'Wieści z orbity: kolejny satelita telekomunikacyjny wyniesiony. Teoretycznie internet w każdym wąwozie. Praktycznie — i tak warto cache.',
  'Nowe: przycisk „Pobierz 50 ostatnich” przy profilu. Włączasz wifi, klikasz, potem metro.',
  'Import biblioteki: wywieź .xoffline.json na drugim telefonie i masz ten sam zestaw postów. Bez chmury, bez konta.',
  'Nie wiem co bardziej ratuje offline-first: service worker czy świadomość, że i tak nic nie załaduję na 1 barze.',
  'Test w terenie, tunel pod Dworcową: 0 zasięgu, 100% postów czytelnych. Tak to ma działać.',
];

const now = Date.now();
const DAY = 86_400_000;
const posts = [];
for (let i = 0; i < 34; i++) {
  const acc = accounts[i % accounts.length];
  const media = [];
  const roll = rand();
  const withImage = roll > 0.24;
  const withClip = roll < 0.16;
  if (withImage) {
    const count = withClip ? 0 : i % 7 === 3 ? 2 : i % 11 === 5 ? 3 : 1;
    for (let k = 0; k < Math.max(1, count); k++) {
      const idx = ((i * 3 + k) % 14) + 1;
      media.push({
        kind: 'image',
        url: `/demo-media/img-${String(idx).padStart(2, '0')}.svg`,
        width: 1200,
        height: 675,
        alt: 'zdjęcie demonstracyjne',
      });
      writeFileSync(
        join(mediaDir, `img-${String(idx).padStart(2, '0')}.svg`),
        photoSvg(idx, { title: idx % 3 === 0 ? 'licznik pobierania' : '', palette: palettes[idx % palettes.length] }),
      );
    }
  }
  if (withClip) {
    const idx = (i % 3) + 1;
    writeFileSync(
      join(mediaDir, `clip-${String(idx).padStart(2, '0')}.svg`),
      clipSvg(idx, {
        palette: palettes[(i + 2) % palettes.length],
        label: pick(['KLIP 0:14', 'REEL 0:32', 'BEZ SIECI']),
      }),
    );
    media.push({
      kind: 'gif',
      url: `/demo-media/clip-${String(idx).padStart(2, '0')}.svg`,
      poster: `/demo-media/img-0${int(1, 9)}.svg`,
      width: 720,
      height: 1280,
      durationMs: int(9000, 34000),
    });
  }
  posts.push({
    id: `demo:d${String(1000 + i)}`,
    nativeId: String(1_800_000_000_000_000_000 + i * 77_313),
    source: 'demo',
    url: `https://x.com/${acc.handle}/status/${1_800_000_000_000_000_000 + i * 77_313}`,
    authorHandle: acc.handle,
    authorName: acc.name,
    createdAt: now - Math.round((i * 0.42 + rand() * 0.5) * DAY * 10) / 10,
    text: texts[i % texts.length] + (rand() > 0.6 ? ` #offline #PWA${i % 4 === 0 ? ' @x_offline' : ''}` : ''),
    lang: rand() > 0.3 ? 'pl' : 'zxx',
    stats: {
      replies: int(2, 380),
      reposts: int(0, 1400),
      likes: int(3, 9800),
      views: int(1200, 2_400_000),
    },
    media,
    sizeBytes: 0,
    savedAt: null,
    fetchedFrom: 'demo',
    ...(i % 9 === 4 ?
      {
        card: {
          domain: pick(['github.com', 'arxiv.org', 'web.dev']),
          title: pick(['Repozytorium projektu', 'Paper: offline-first na krawędzi', 'Przewodnik po PWA']),
          brief: 'Kilka zdań opisu, które zwykle widać w podglądzie linku.',
          url: 'https://example.com/link',
        },
      }
    : {}),
  });
}

posts.sort((a, b) => b.createdAt - a.createdAt);

const accountsOut = accounts.map((a) => ({
  handle: a.handle,
  name: a.name,
  description: a.bio,
  followers: int(1200, 480_000),
}));

writeFileSync(
  join(fixturesDir, 'demo-posts.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), accounts: accountsOut, posts }, null, 2),
);

// Obrazy, które nie zostały użyte w pętli — dorzucamy, żeby siatka zawsze miała z czego wybierać.
for (let idx = 1; idx <= 14; idx++) {
  const f = join(mediaDir, `img-${String(idx).padStart(2, '0')}.svg`);
  try {
    writeFileSync(f, photoSvg(idx, { title: idx % 4 === 1 ? 'pobrano 50 postów' : '', palette: palettes[idx % palettes.length] }), {
      flag: 'wx',
    });
  } catch {}
}
for (let idx = 1; idx <= 3; idx++) {
  try {
    writeFileSync(join(mediaDir, `clip-${String(idx).padStart(2, '0')}.svg`), clipSvg(idx, { palette: palettes[idx], label: 'KLIP' }), {
      flag: 'wx',
    });
  } catch {}
}

console.log(`✓ demo: ${posts.length} postów, ${accounts.length} kont → apps/web/src/fixtures/demo-posts.json`);
