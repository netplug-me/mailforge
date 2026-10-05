import stringWidth from 'string-width';

// Green / yellow / red stay reserved for ok / diff / missing; everything else is decoration.
export const C = {
  accent: '#38bdf8',
  accent2: '#818cf8',
  pink: '#f472b6',
  violet: '#a78bfa',
  ok: '#4ade80',
  warn: '#fbbf24',
  bad: '#f87171',
  muted: '#94a3b8',
  faint: '#64748b',
  border: '#475569',
  selectedBg: '#1e3a5f',
  gradient: ['#38bdf8', '#818cf8', '#f472b6'],
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Colour at position `t` (0..1) along a list of gradient stops. */
export function gradientAt(stops: readonly string[], t: number): string {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * (x - i)));
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Cuts `s` to `width` terminal columns, ending in an ellipsis when it was shortened. */
export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(s) <= width) return s;
  let out = '';
  for (const ch of [...s]) {
    if (stringWidth(out + ch) > width - 1) break;
    out += ch;
  }
  return out + '…';
}

/** Truncates or pads `s` to exactly `width` columns. */
export function fit(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const t = truncate(s, width);
  const pad = ' '.repeat(Math.max(0, width - stringWidth(t)));
  return align === 'right' ? pad + t : t + pad;
}

export function bar(fraction: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function usageColor(fraction: number): string {
  return fraction > 0.9 ? C.bad : fraction > 0.7 ? C.warn : C.ok;
}

/** First visible row of a `height`-row window that keeps `selected` in view (centred when scrolling). */
export function windowStart(selected: number, count: number, height: number): number {
  if (count <= height) return 0;
  return Math.max(0, Math.min(count - height, selected - Math.floor(height / 2)));
}

/** A readable random password without look-alike characters. */
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
