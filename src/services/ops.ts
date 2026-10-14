import dns from 'node:dns/promises';
import type { MxRecord } from 'node:dns';
import { getAppConfig } from '../config.js';
import { DockerService, ExecResult } from './docker.js';

// Day-to-day operations on a running mail server. Parsers are exported pure functions
// so they can be tested without a container.

export interface QueueEntry {
  id: string;
  queue: string;
  sender: string;
  recipients: string[];
  size: number;
  arrived: Date;
  reason?: string;
}

export interface QuotaRow {
  user: string;
  usedKb: number;
  limitKb?: number;
  messages: number;
}

export interface DeliveryRow {
  time: string;
  status: string;
  to: string;
  relay: string;
  detail: string;
}

export interface Client {
  user: string;
  connections: number;
  service: string;
  ips: string;
}

export interface CertInfo {
  notAfter: Date;
  daysLeft: number;
  issuer: string;
}

export interface PostmarkStats {
  sent: number;
  bounced: number;
  spamComplaints: number;
  opens: number;
  days: number;
}

export interface PostmarkBounce {
  email: string;
  type: string;
  at: string;
  detail: string;
}

export function parseQueue(json: string): QueueEntry[] {
  return json
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .flatMap((l) => {
      try {
        const q = JSON.parse(l);
        return [
          {
            id: String(q.queue_id),
            queue: String(q.queue_name),
            sender: String(q.sender ?? ''),
            recipients: (q.recipients ?? []).map((r: any) => String(r.address)),
            size: Number(q.message_size ?? 0),
            arrived: new Date(Number(q.arrival_time ?? 0) * 1000),
            reason: q.recipients?.find((r: any) => r.delay_reason)?.delay_reason,
          },
        ];
      } catch {
        return [];
      }
    });
}

/** `doveadm quota get -A`: STORAGE rows are KiB, MESSAGE rows are counts; "-" means unlimited. */
export function parseQuota(out: string): QuotaRow[] {
  const rows = new Map<string, QuotaRow>();
  for (const line of out.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [user, , type, value, limit] = f;
    const row = rows.get(user) ?? { user, usedKb: 0, messages: 0 };
    if (type === 'STORAGE') {
      row.usedKb = Number(value) || 0;
      row.limitKb = limit === '-' ? undefined : Number(limit) || undefined;
    } else if (type === 'MESSAGE') {
      row.messages = Number(value) || 0;
    }
    rows.set(user, row);
  }
  return [...rows.values()];
}

export function formatKb(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)}G`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${kb}K`;
}

/** Only final-hop outcomes: skips the amavis/content-filter loopback hops that double-count. */
export function parseDelivery(log: string): DeliveryRow[] {
  const rows: DeliveryRow[] = [];
  for (const line of log.split('\n')) {
    const status = line.match(/status=(\w+)(?: \((.*)\))?/);
    if (!status || line.includes('relay=127.0.0.1')) continue;
    const time = line.match(/T(\d\d:\d\d:\d\d)/)?.[1] ?? '';
    const to = line.match(/to=<([^>]*)>/)?.[1] ?? '?';
    const relay = line.match(/relay=([^\s,\[]+)/)?.[1] ?? '';
    rows.push({ time, status: status[1], to, relay, detail: (status[2] ?? '').slice(0, 80) });
  }
  return rows;
}

/** Columns: user, connection count, service, "(pid pid …)", "(ip …)". */
export function parseWho(out: string): Client[] {
  return out
    .split('\n')
    .slice(1)
    .flatMap((l) => {
      const m = l.trim().match(/^(\S+)\s+(\d+)\s+(\S+)\s+\([^)]*\)\s*\(([^)]*)\)/);
      return m ? [{ user: m[1], connections: Number(m[2]), service: m[3], ips: m[4].trim() }] : [];
    });
}

/** `fail2ban-client banned` prints a python-ish list: [{'postfix': ['1.2.3.4']}, ...]. */
export function parseBanned(out: string): Array<{ jail: string; ips: string[] }> {
  return [...out.matchAll(/'([\w-]+)':\s*\[([^\]]*)\]/g)].map((m) => ({
    jail: m[1],
    ips: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  }));
}

export function parseCert(out: string, now = new Date()): CertInfo | undefined {
  const end = out.match(/notAfter=(.+)/)?.[1];
  if (!end) return undefined;
  const notAfter = new Date(end.replace(/\s+GMT$/, ' UTC'));
  if (Number.isNaN(notAfter.getTime())) return undefined;
  return {
    notAfter,
    daysLeft: Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000),
    issuer: out.match(/issuer=.*?CN\s*=\s*([^,\n]+)/)?.[1]?.trim() ?? out.match(/issuer=(.+)/)?.[1] ?? '',
  };
}

export function parsePostmarkStats(json: any, days: number): PostmarkStats {
  return {
    sent: Number(json?.Sent ?? 0),
    bounced: Number(json?.Bounced ?? 0),
    spamComplaints: Number(json?.SpamComplaints ?? 0),
    opens: Number(json?.Opens ?? 0),
    days,
  };
}


// ── Live feed (Overview screen) ──────────────────────────────────────────────

export type LogClass =
  | 'out' | 'bounce' | 'defer' | 'in' | 'blocked' | 'reject'
  | 'login' | 'authfail' | 'probe' | 'system' | 'session' | 'other' | 'noise';

export interface LogEvent {
  ts?: Date;
  /** HH:MM:SS as written in the log (the container's local time). */
  time: string;
  /** Short origin: smtpd, dovecot, amavis, … */
  proc: string;
  cls: LogClass;
  text: string;
  ip?: string;
  /** Out/bounce/defer rows: recipient and relay. In rows: sender and local mailbox. */
  who?: string;
  via?: string;
}

/** The compose network's cloudflared address: HAProxy's health checks arrive from it every few seconds. */
const NOISE_PEER = /172\.25\.0\.11|cloudflared-\d/;
const IPV4 = /(\d{1,3}(?:\.\d{1,3}){3})/;

function shortProc(proc: string): string {
  const parts = proc.split('/');
  return parts[parts.length - 1] || proc;
}

function classifyLine(proc: string, msg: string): Pick<LogEvent, 'cls' | 'text' | 'ip' | 'who' | 'via'> {
  const ip = msg.match(new RegExp(`(?:\\[|rip=)${IPV4.source}`))?.[1];
  const base = { ip, text: msg };
  if (NOISE_PEER.test(msg) || (proc === 'opendmarc' && /ignoring connection/.test(msg))) return { ...base, cls: 'noise' };
  if (/TLS library problem|Anonymous TLS connection established|Untrusted TLS connection established/.test(msg)) {
    return { ...base, cls: 'noise' };
  }

  if (proc === 'amavis') {
    const m = msg.match(/(Passed|Blocked) (\S+) \{(\w+)\}.*?<([^>]*)> -> <([^>]*)>/);
    if (m && /Inbound$/.test(m[3])) {
      const verdict = m[2];
      return { ...base, cls: m[1] === 'Blocked' ? 'blocked' : 'in', who: m[4] || '(null sender)', via: m[5], text: `${m[4] || '(null sender)'} → ${m[5]}  ${verdict}` };
    }
    return { ...base, cls: 'session' };
  }

  const st = msg.match(/\bto=<([^>]*)>.*?relay=([^\s,\[]+).*?status=(\w+)(?: \((.*)\))?/);
  if (st) {
    const [, to, relay, status, detail = ''] = st;
    if (relay === '127.0.0.1' || /lmtp/.test(proc) || /dovecot-lmtp|\/lmtp/.test(msg)) return { ...base, cls: 'session' };
    const cls: LogClass = status === 'sent' ? 'out' : status === 'bounced' ? 'bounce' : 'defer';
    return { ...base, cls, who: to, via: relay, text: `→ ${to}  via ${relay}${cls === 'out' ? '' : `  ${detail.slice(0, 80)}`}` };
  }

  if (/NOQUEUE: reject:/.test(msg)) {
    const m = msg.match(/reject: (\w+) from [^\[]*\[([^\]]+)\]: (\d{3} \d\.\d\.\d) (.*?)(?:; from=|$)/);
    return { ...base, cls: 'reject', ip: m?.[2] ?? ip, text: m ? `reject ${m[2]}  ${m[3]}  ${m[4]}` : msg.slice(0, 120) };
  }

  if (/SSL_accept error from/.test(msg)) return { ...base, cls: 'probe', text: `TLS handshake failed from ${ip ?? '?'}` };
  if (/improper command pipelining/.test(msg)) return { ...base, cls: 'probe', text: `non-SMTP probe on ${shortProc(proc)} from ${ip ?? '?'}` };
  if (/Login aborted/.test(msg) && /user=<>/.test(msg)) {
    const why = msg.match(/\((\w+)\):/)?.[1] ?? 'aborted';
    const svc = msg.match(/^([\w-]+):/)?.[1] ?? shortProc(proc);
    return { ...base, cls: 'probe', text: `${svc} connection from ${ip ?? '?'}  ${why.replace(/_/g, ' ')}` };
  }
  if (/authentication failed|auth failed|Aborted login/.test(msg)) {
    return { ...base, cls: 'authfail', text: `auth failed  ${msg.match(/user=<([^>]*)>/)?.[1] || msg.match(/sasl_username=(\S+)/)?.[1] || ''} from ${ip ?? '?'}`.trim() };
  }
  const login = msg.match(/Logged in: user=<([^>]*)>.*?rip=([\d.]+)/);
  if (login) return { ...base, cls: 'login', ip: login[2], who: login[1], text: `${login[1]} logged in from ${login[2]}` };
  const sasl = msg.match(/client=[^,]*\[([\d.]+)\],.*sasl_username=(\S+)/);
  if (sasl) return { ...base, cls: 'login', ip: sasl[1], who: sasl[2], text: `${sasl[2]} authenticated (SMTP) from ${sasl[1]}` };

  if (/starting up|daemon started|starting the Postfix|OpenDKIM Filter .* starting/.test(msg)) return { ...base, cls: 'system' };
  if (/^(connect|disconnect) from|lost connection|timeout after|Disconnected:|Connection closed|Logged out|Aborted login|^statistics:/.test(msg)) {
    return { ...base, cls: 'session' };
  }
  return { ...base, cls: 'other' };
}

/**
 * Classifies a mail.log excerpt. Health-check chatter from cloudflared is kept but tagged `noise`
 * so the timestamps still bound the span; the view decides what to show.
 */
export function parseMailLog(log: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of log.split('\n')) {
    const m = line.match(/^(\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)\.\d+[+-]\d\d:\d\d)\s+\S+\s+([^\s:\[]+)(?:\[\d+\])?:\s*(.*)$/);
    if (!m) continue;
    const ts = new Date(m[1]);
    events.push({
      ts: Number.isNaN(ts.getTime()) ? undefined : ts,
      time: m[2],
      proc: shortProc(m[3]),
      ...classifyLine(m[3], m[4]),
    });
  }
  return events;
}

export interface LogStats {
  from?: Date;
  to?: Date;
  spanMs: number;
  counts: Record<LogClass, number>;
  /** Delivered + received per bucket, and probes + failed auths + rejects per bucket, oldest first. */
  mail: number[];
  threats: number[];
  probeIps: number;
}

const ALL_CLASSES: LogClass[] = ['out', 'bounce', 'defer', 'in', 'blocked', 'reject', 'login', 'authfail', 'probe', 'system', 'session', 'other', 'noise'];

export function computeLogStats(events: LogEvent[], buckets = 24): LogStats {
  const counts = Object.fromEntries(ALL_CLASSES.map((c) => [c, 0])) as Record<LogClass, number>;
  const stamped = events.filter((e) => e.ts);
  const from = stamped[0]?.ts;
  const to = stamped[stamped.length - 1]?.ts;
  const spanMs = from && to ? Math.max(0, to.getTime() - from.getTime()) : 0;
  const mail = new Array<number>(buckets).fill(0);
  const threats = new Array<number>(buckets).fill(0);
  const ips = new Set<string>();
  for (const e of events) {
    counts[e.cls]++;
    if (e.cls === 'probe' && e.ip) ips.add(e.ip);
    if (!e.ts || !from || spanMs === 0) continue;
    const b = Math.min(buckets - 1, Math.floor(((e.ts.getTime() - from.getTime()) / spanMs) * buckets));
    if (e.cls === 'out' || e.cls === 'in' || e.cls === 'bounce' || e.cls === 'defer') mail[b]++;
    else if (e.cls === 'probe' || e.cls === 'authfail' || e.cls === 'reject') threats[b]++;
  }
  return { from, to, spanMs, counts, mail, threats, probeIps: ips.size };
}

export interface F2bEvent {
  /** "MM-DD HH:MM:SS" in the container's local time. */
  when: string;
  jail: string;
  action: 'ban' | 'unban' | 'found';
  ip: string;
}

export function parseFail2banLog(log: string): F2bEvent[] {
  const events: F2bEvent[] = [];
  for (const line of log.split('\n')) {
    const m = line.match(/^\d{4}-(\d\d-\d\d) (\d\d:\d\d:\d\d),\d+ fail2ban\.\w+\s+\[\d+\]:\s+\w+\s+\[([\w.-]+)\] (Restore Ban|Ban|Unban|Found) (\S+)/);
    if (!m) continue;
    events.push({
      when: `${m[1]} ${m[2]}`,
      jail: m[3],
      action: m[4] === 'Unban' ? 'unban' : m[4] === 'Found' ? 'found' : 'ban',
      ip: m[5],
    });
  }
  return events;
}

/** Splits output that a shell script labelled with `@@NAME` marker lines. */
export function parseSections(out: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let name = '';
  const lines = out.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // the output's own trailing newline
  for (const line of lines) {
    const m = line.match(/^@@(\w+)$/);
    if (m) {
      name = m[1];
      sections[name] = '';
    } else if (name) sections[name] += line + '\n';
  }
  return sections;
}

export interface ContainerStats {
  cpu: string;
  mem: string;
  memPct: number;
}

/** One poll of everything the Overview shows, gathered with a single `docker exec`. */
export interface LiveData {
  at: Date;
  /** Several days of mail.log with the health-check chatter filtered out in the container. */
  events: LogEvent[];
  /** The newest raw lines, noise included, for the "all" view. */
  raw: LogEvent[];
  stats: LogStats;
  f2bEvents: F2bEvent[];
  jails?: Array<{ jail: string; ips: string[] }>;
  queue?: { total: number; deferred: number; active: number };
  clients: Client[];
  load?: string;
  /** Host-side extras, filled in by the poller. */
  watcher?: string;
  startedAt?: Date;
  container?: ContainerStats;
  error?: string;
}

export function parseLive(out: string, at = new Date()): LiveData {
  const s = parseSections(out);
  const events = parseMailLog(s.LOG ?? '');
  const raw = parseMailLog(s.RAW ?? '');
  const queueText = s.QUEUE ?? '';
  const queue = queueText.trim().startsWith('postqueue') || /fatal|error/i.test(queueText) ? undefined : parseQueue(queueText);
  return {
    at,
    events,
    raw,
    stats: computeLogStats(events),
    f2bEvents: parseFail2banLog(s.F2B ?? ''),
    jails: s.BANNED && /^\s*\[/.test(s.BANNED) ? parseBanned(s.BANNED) : undefined,
    queue: queue && {
      total: queue.length,
      deferred: queue.filter((q) => q.queue === 'deferred').length,
      active: queue.filter((q) => q.queue === 'active').length,
    },
    clients: s.WHO && !/error|fatal/i.test(s.WHO) ? parseWho(s.WHO) : [],
    load: s.LOAD?.trim().split(/\s+/).slice(0, 3).join(' ') || undefined,
  };
}

/** `docker stats --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'` output. */
export function parseContainerStats(out: string): ContainerStats | undefined {
  const [cpu, mem, pct] = out.trim().split('|');
  if (!cpu || !mem) return undefined;
  return { cpu, mem: mem.split('/')[0].trim(), memPct: Number.parseFloat(pct) || 0 };
}

const LIVE_SCRIPT = [
  // Drop the cloudflared health checks in the container: they are ~98% of the log, so a plain tail covers hours.
  "echo '@@LOG'; grep -vE '172\\.25\\.0\\.11|cloudflared-[0-9]|opendmarc.*ignoring connection' /var/log/mail/mail.log 2>/dev/null | tail -n 4000",
  "echo '@@RAW'; tail -n 200 /var/log/mail/mail.log 2>/dev/null",
  "echo '@@F2B'; tail -n 400 /var/log/mail/fail2ban.log 2>/dev/null",
  "echo '@@BANNED'; fail2ban-client banned 2>&1",
  "echo '@@QUEUE'; postqueue -j 2>&1",
  "echo '@@WHO'; doveadm who 2>&1",
  "echo '@@LOAD'; cat /proc/loadavg",
].join('; ');

export class OpsService {
  private docker = new DockerService();

  private run(args: string[], input?: string): Promise<ExecResult> {
    return this.docker.execAsync(args, input);
  }

  async queue(): Promise<QueueEntry[]> {
    const res = await this.run(['postqueue', '-j']);
    if (!res.success) throw new Error((res.stderr || res.stdout).trim() || 'postqueue failed');
    return parseQueue(res.stdout);
  }

  flushQueue = () => this.run(['postqueue', '-f']);
  deleteDeferred = () => this.run(['postsuper', '-d', 'ALL', 'deferred']);

  async recentDelivery(count = 40): Promise<DeliveryRow[]> {
    const res = await this.run(['sh', '-c', 'grep -E "status=" /var/log/mail/mail.log | tail -n 400']);
    return parseDelivery(res.stdout).slice(-count);
  }

  async quotas(): Promise<QuotaRow[]> {
    const res = await this.run(['doveadm', 'quota', 'get', '-A']);
    if (!res.success) throw new Error((res.stderr || res.stdout).trim() || 'doveadm failed');
    return parseQuota(res.stdout);
  }

  async clients(): Promise<Client[]> {
    const res = await this.run(['doveadm', 'who']);
    if (!res.success) throw new Error((res.stderr || res.stdout).trim() || 'doveadm failed');
    return parseWho(res.stdout);
  }

  async banned(): Promise<Array<{ jail: string; ips: string[] }>> {
    const res = await this.run(['fail2ban-client', 'banned']);
    if (!res.success) throw new Error((res.stderr || res.stdout).trim() || 'fail2ban is not running');
    return parseBanned(res.stdout);
  }

  unban = (ip: string) => this.run(['fail2ban-client', 'unban', ip]);

  /** Everything the Overview needs from inside the container, in one exec. */
  async live(): Promise<LiveData> {
    const res = await this.run(['sh', '-c', LIVE_SCRIPT]);
    if (!res.success && !res.stdout) throw new Error((res.stderr || 'docker exec failed').trim());
    return parseLive(res.stdout);
  }

  async cert(): Promise<CertInfo | undefined> {
    const host = getAppConfig().mxHost;
    const res = await this.run([
      'openssl', 'x509', '-in', `/etc/letsencrypt/live/${host}/fullchain.pem`, '-noout', '-enddate', '-issuer',
    ]);
    return res.success ? parseCert(res.stdout) : undefined;
  }

  /** Container state of each stage of the inbound/outbound path. */
  async pipeline() {
    const config = getAppConfig();
    const mxHost = config.mxHost;
    const domain = config.primaryDomain;
    const [bridge, tunnel, mx] = await Promise.all([
      this.docker.serviceState('inbound-bridge'),
      this.docker.serviceState('cloudflared'),
      dns.resolveMx(domain).catch((err: any) => {
        if (err.code === 'ERR_INVALID_ARGUMENT') return [] as MxRecord[];
        return [] as MxRecord[];
      }),
    ]);
    return {
      bridge,
      tunnel,
      mx: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange),
      mailserver: await this.docker.serviceState('mailserver'),
      relayConfigured: Boolean(process.env.POSTMARK_SERVER_TOKEN),
      mxHost,
    };
  }

  private async postmark(path: string): Promise<any> {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) throw new Error('POSTMARK_SERVER_TOKEN is not set in .env');
    const res = await fetch(`https://api.postmarkapp.com${path}`, {
      headers: { Accept: 'application/json', 'X-Postmark-Server-Token': token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Postmark API returned ${res.status}`);
    return res.json();
  }

  async postmarkStats(days = 7): Promise<PostmarkStats> {
    const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return parsePostmarkStats(await this.postmark(`/stats/outbound?fromdate=${from}`), days);
  }

  async postmarkBounces(count = 5): Promise<PostmarkBounce[]> {
    const json = await this.postmark(`/bounces?count=${count}&offset=0`);
    return (json.Bounces ?? []).map((b: any) => ({
      email: String(b.Email),
      type: String(b.Type),
      at: String(b.BouncedAt ?? '').slice(0, 16).replace('T', ' '),
      detail: String(b.Details ?? '').slice(0, 80),
    }));
  }

  /** Sends a plain-text message through the same path real mail takes (postfix → relay). */
  sendTest(from: string, to: string): Promise<ExecResult> {
    const msg = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: mailforge test ${new Date().toISOString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Test message sent from the mailforge TUI.',
      '',
    ].join('\n');
    return this.run(['sendmail', '-t', '-f', from], msg);
  }
}
