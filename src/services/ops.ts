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

  async cert(): Promise<CertInfo | undefined> {
    const host = getAppConfig().mxHost;
    const res = await this.run([
      'openssl', 'x509', '-in', `/etc/letsencrypt/live/${host}/fullchain.pem`, '-noout', '-enddate', '-issuer',
    ]);
    return res.success ? parseCert(res.stdout) : undefined;
  }

  /** Container state of each stage of the inbound/outbound path. */
  async pipeline() {
    const mxHost = getAppConfig().mxHost;
    const domain = getAppConfig().primaryDomain;
    const [bridge, tunnel, mx] = await Promise.all([
      this.docker.serviceState('inbound-bridge'),
      this.docker.serviceState('cloudflared'),
      dns.resolveMx(domain).catch(() => [] as MxRecord[]),
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
      `Subject: mailctl test ${new Date().toISOString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Test message sent from the mailctl TUI.',
      '',
    ].join('\n');
    return this.run(['sendmail', '-t', '-f', from], msg);
  }
}
