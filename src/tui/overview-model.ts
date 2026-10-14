import type { F2bEvent, LiveData, LogClass, LogEvent } from '../services/ops.js';
import { C } from './theme.js';

// Pure helpers behind the Overview screen: no Ink, no I/O, so they can be tested directly.

const SPARK = '▁▂▃▄▅▆▇█';

/** One block per column, scaled to the series maximum; empty buckets stay at the lowest bar. */
export function sparkline(values: number[], width: number): string {
  if (width <= 0) return '';
  if (values.length === 0) return '▁'.repeat(width);
  // Resample to `width` columns by summing the buckets that fall into each.
  const cols = new Array<number>(width).fill(0);
  values.forEach((v, i) => {
    cols[Math.min(width - 1, Math.floor((i / values.length) * width))] += v;
  });
  const max = Math.max(...cols);
  if (max === 0) return '▁'.repeat(width);
  return cols.map((v) => (v === 0 ? '▁' : SPARK[Math.max(1, Math.min(7, Math.ceil((v / max) * 7)))])).join('');
}

/** "3d 8h", "12h 4m", "45m", "30s". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
export const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

export interface LogRow {
  time: string;
  /** "MM-DD" of the event, or '' when the log line carried no timestamp. */
  day: string;
  cls: LogClass;
  proc: string;
  text: string;
  /** How many adjacent identical events this row stands for. */
  count: number;
}

const dayOf = (e: LogEvent) => (e.ts ? `${pad2(e.ts.getMonth() + 1)}-${pad2(e.ts.getDate())}` : '');

/** Today as "MM-DD", for deciding which rows need a date. */
export const today = (now = new Date()) => `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

/** Merges runs of identical events (one scanner can log the same line a dozen times a second). */
export function collapse(events: LogEvent[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (last && last.cls === e.cls && last.proc === e.proc && last.text === e.text) {
      last.count++;
      last.time = e.time;
      last.day = dayOf(e);
    } else rows.push({ time: e.time, day: dayOf(e), cls: e.cls, proc: e.proc, text: e.text, count: 1 });
  }
  return rows;
}

export const LOG_FILTERS = [
  { key: 'signal', label: 'signal' },
  { key: 'problems', label: 'problems' },
  { key: 'all', label: 'raw' },
] as const;

const QUIET: LogClass[] = ['noise', 'session'];
const PROBLEMS: LogClass[] = ['bounce', 'defer', 'blocked', 'reject', 'authfail', 'probe'];

/** Log rows for a filter mode, oldest first. `signal` hides health checks and routine session chatter. */
export function logRows(live: LiveData | undefined, filter: number): LogRow[] {
  if (!live) return [];
  const mode = LOG_FILTERS[filter % LOG_FILTERS.length].key;
  if (mode === 'all') return collapse(live.raw);
  return collapse(live.events.filter((e) => (mode === 'problems' ? PROBLEMS.includes(e.cls) : !QUIET.includes(e.cls))));
}

export interface MailRow {
  when: string;
  dir: 'out' | 'in';
  cls: LogClass;
  who: string;
  via: string;
}

const MAIL: LogClass[] = ['out', 'bounce', 'defer', 'in', 'blocked'];

/** Newest-first mail movements. Rows from before today carry their date. */
export function mailRows(live: LiveData | undefined, limit: number, now = new Date()): MailRow[] {
  if (!live) return [];
  const out: MailRow[] = [];
  for (let i = live.events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = live.events[i];
    if (!MAIL.includes(e.cls)) continue;
    const today = e.ts && e.ts.toDateString() === now.toDateString();
    const when = today || !e.ts ? e.time : `${pad2(e.ts.getMonth() + 1)}-${pad2(e.ts.getDate())} ${e.time.slice(0, 5)}`;
    const inbound = e.cls === 'in' || e.cls === 'blocked';
    out.push({ when, dir: inbound ? 'in' : 'out', cls: e.cls, who: e.who ?? '?', via: inbound ? `→ ${e.via ?? '?'}` : e.via ?? '' });
  }
  return out;
}

export interface BanRow {
  ip: string;
  jails: string[];
}

/** Currently banned addresses, merged across jails. */
export function banRows(live: LiveData | undefined): BanRow[] {
  const byIp = new Map<string, string[]>();
  for (const j of live?.jails ?? []) for (const ip of j.ips) byIp.set(ip, [...(byIp.get(ip) ?? []), j.jail]);
  return [...byIp].map(([ip, jails]) => ({ ip, jails }));
}

/** Newest-first fail2ban activity, with repeated "Found" strikes from one address folded together. */
export function f2bFeed(events: F2bEvent[] | undefined, limit: number): Array<F2bEvent & { count: number }> {
  const rows: Array<F2bEvent & { count: number }> = [];
  for (let i = (events?.length ?? 0) - 1; i >= 0 && rows.length < limit; i--) {
    const e = events![i];
    const prev = rows[rows.length - 1];
    if (prev && prev.action === e.action && prev.ip === e.ip && prev.jail === e.jail) prev.count++;
    else rows.push({ ...e, count: 1 });
  }
  return rows;
}

export interface Tile {
  label: string;
  value: string;
  sub?: string;
  color: string;
}

/** Headline numbers in priority order; the screen shows as many as fit. */
export function pulseTiles(live: LiveData | undefined, certDays?: number): Tile[] {
  const n = live?.stats.counts;
  const num = (v: number | undefined) => (v === undefined ? '—' : String(v));
  const bad = n ? n.bounce + n.defer + n.blocked + n.reject : undefined;
  const bans = banRows(live).length;
  const users = new Set(live?.clients.map((c) => c.user)).size;
  return [
    { label: 'RECEIVED', value: num(n?.in), color: C.accent },
    { label: 'SENT', value: num(n?.out), color: C.ok },
    { label: 'BOUNCED/REJ', value: num(bad), color: bad ? C.bad : C.muted },
    { label: 'BANNED', value: live?.jails ? String(bans) : '—', sub: live?.jails ? undefined : 'no fail2ban', color: bans ? C.bad : C.ok },
    { label: 'PROBES', value: num(n?.probe), sub: live?.stats.probeIps ? `${live.stats.probeIps} IPs` : undefined, color: n?.probe ? C.pink : C.muted },
    {
      label: 'QUEUE',
      value: num(live?.queue?.total),
      sub: live?.queue?.deferred ? `${live.queue.deferred} deferred` : undefined,
      color: live?.queue?.deferred ? C.warn : C.muted,
    },
    { label: 'LOGINS', value: num(n?.login), sub: n?.authfail ? `${n.authfail} failed` : undefined, color: n?.authfail ? C.warn : C.violet },
    { label: 'ONLINE', value: live ? String(users) : '—', color: users ? C.ok : C.muted },
    { label: 'CERT', value: certDays === undefined ? '—' : `${certDays}d`, color: certDays === undefined ? C.muted : certDays < 14 ? C.bad : certDays < 30 ? C.warn : C.ok },
  ];
}
