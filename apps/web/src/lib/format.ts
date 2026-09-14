export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'teraz';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} godz`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} dni`;
  return new Date(ts).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function compact(n: number | undefined): string {
  if (n == null) return '';
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')} tys.`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} tys.`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')} mln`;
}

export function bytesLabel(b: number | undefined): string {
  if (!b) return '0 kB';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} kB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const AVATAR_HUES = [210, 265, 330, 20, 45, 100, 160, 190];

export function avatarColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) % 9973;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  return `hsl(${hue} 62% 48%)`;
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  if (!parts[0]) return 'X';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Zamienia tekst na segmenty do podświetlenia linków / hashtagów / wzmianek. */
export type Segment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; value: string; href: string }
  | { kind: 'tag'; value: string };

const TOKEN_RE = /(https?:\/\/[^\s]+|[@#][\p{L}\p{N}_.'-]+)/gu;

export function segmentText(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: 'text', value: text.slice(last, idx) });
    const value = m[0];
    if (/^https?:/.test(value)) out.push({ kind: 'link', value, href: value.replace(/[).,]+$/, '') });
    else out.push({ kind: 'tag', value });
    last = idx + value.length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out.length ? out : [{ kind: 'text', value: text }];
}
