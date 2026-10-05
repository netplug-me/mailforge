import { getAppConfig } from '../config.js';
import { DockerService, ExecResult } from '../services/docker.js';
import { OpsService, formatKb } from '../services/ops.js';
import { isValidEmail } from '../utils/validator.js';
import { isCancel, ui } from './ui.js';

const BACK = { value: 'back', label: 'Back', icon: '←', color: '#94a3b8' } as const;

function reportExec(res: ExecResult, ok: string, fail: string) {
  if (res.success) {
    ui.success(ok);
  } else {
    ui.error(fail);
    const detail = (res.stderr || res.stdout).trim();
    if (detail) ui.line(detail);
  }
}

export async function actionDockerControl(): Promise<void> {
  const docker = new DockerService();

  const choice = await ui.select('Container action', [
    { value: 'status', label: 'Check status' },
    { value: 'logs', label: 'View recent logs' },
    { value: 'up', label: 'Start (compose up -d)' },
    { value: 'restart', label: 'Restart' },
    { value: 'recreate', label: 'Force recreate' },
    { value: 'down', label: 'Stop (compose down)' },
    BACK,
  ]);
  if (isCancel(choice) || choice === 'back') return;

  if (choice === 'status') {
    ui.info(`Container status: ${docker.getContainerStatus().toUpperCase()}`);
  } else if (choice === 'logs') {
    const res = await ui.task('Fetching logs…', () => docker.getLogsAsync(40));
    ui.begin('Mail server logs (last 40 lines)');
    const out = (res.stdout || res.stderr).trimEnd();
    if (out) ui.raw(out);
    else ui.line('No logs available.');
  } else if (choice === 'up') {
    const res = await ui.task('Starting container…', () => docker.composeUpAsync());
    reportExec(res, 'Container started', 'Failed to start container');
  } else if (choice === 'restart') {
    const res = await ui.task('Restarting container…', () => docker.composeRestartAsync());
    reportExec(res, 'Container restarted', 'Failed to restart container');
  } else if (choice === 'recreate') {
    const sure = await ui.confirm('Recreate the mail server container? Mail is unavailable for ~30s.', { danger: true });
    if (isCancel(sure) || !sure) return;
    const res = await ui.task('Recreating container…', () => docker.composeUpAsync(true));
    reportExec(res, 'Container recreated and running', 'Failed to recreate container');
  } else if (choice === 'down') {
    const sure = await ui.confirm(`Stop the mail server? Inbound mail can't be delivered until it is started again.`, {
      danger: true,
    });
    if (isCancel(sure) || !sure) return;
    const res = await ui.task('Stopping container…', () => docker.composeDownAsync());
    reportExec(res, 'Container stopped', 'Failed to stop container');
  }
}

// ── Tools (the Tools screen lists these) ─────────────────────────────────────

const OK = '#4ade80';
const WARN = '#fbbf24';
const BAD = '#f87171';

function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function loadOrError<T>(message: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await ui.task(message, fn);
  } catch (err: any) {
    ui.begin('Error');
    ui.error(err?.message ?? String(err));
    return undefined;
  }
}

export async function toolMailQueue(): Promise<void> {
  const ops = new OpsService();
  while (true) {
    const queue = await loadOrError('Reading the mail queue…', () => ops.queue());
    if (!queue) return;
    ui.begin(`Mail queue · ${queue.length} message(s)`);
    if (queue.length === 0) ui.colored('Queue is empty — nothing waiting to be delivered.', OK);
    for (const q of queue.slice(0, 30)) {
      const color = q.queue === 'deferred' ? WARN : q.queue === 'hold' ? BAD : '#38bdf8';
      ui.colored(`${q.queue.padEnd(8)} ${q.id}  ${formatKb(Math.ceil(q.size / 1024)).padStart(6)}`, color);
      ui.line(`  ${q.sender || '<>'} → ${q.recipients.join(', ')}`);
      if (q.reason) ui.colored(`  ${q.reason}`, WARN);
    }
    if (queue.length > 30) ui.info(`${queue.length - 30} more not shown`);

    const choice = await ui.select('Queue action', [
      { value: 'refresh', label: 'Refresh', icon: '⟳' },
      { value: 'flush', label: 'Retry delivery now (flush)', icon: '➤', color: OK },
      { value: 'delete', label: 'Delete all deferred mail', icon: '✖', color: BAD },
      BACK,
    ]);
    if (isCancel(choice) || choice === 'back') return;
    if (choice === 'flush') {
      const res = await ui.task('Flushing the queue…', () => ops.flushQueue());
      reportExec(res, 'Flush requested; check the delivery log for results', 'Flush failed');
    } else if (choice === 'delete') {
      const sure = await ui.confirm('Permanently delete every deferred message? Senders are not notified.', {
        danger: true,
      });
      if (isCancel(sure) || !sure) continue;
      const res = await ui.task('Deleting deferred mail…', () => ops.deleteDeferred());
      reportExec(res, 'Deferred mail deleted', 'Delete failed');
    }
  }
}

const STATUS_COLOR: Record<string, string> = { sent: OK, deferred: WARN, bounced: BAD, expired: BAD };

export async function toolDeliveryLog(): Promise<void> {
  const rows = await loadOrError('Reading the mail log…', () => new OpsService().recentDelivery(60));
  if (!rows) return;
  ui.begin('Delivery log · newest at the bottom');
  if (rows.length === 0) ui.line('No deliveries logged yet.');
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    const via = r.relay.includes('postmark') ? 'postmark' : r.relay;
    ui.colored(`${r.time} ${r.status.padEnd(8)} ${r.to} via ${via}`, STATUS_COLOR[r.status] ?? '#94a3b8');
    if (r.status !== 'sent' && r.detail) ui.colored(`         ${r.detail}`, STATUS_COLOR[r.status] ?? '#94a3b8');
  }
  ui.heading('Summary');
  ui.line(
    Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('   ') || '—'
  );
}

export async function toolQuotas(): Promise<void> {
  const rows = await loadOrError('Reading mailbox usage…', () => new OpsService().quotas());
  if (!rows) return;
  ui.begin('Mailbox usage');
  const width = Math.max(...rows.map((r) => r.user.length), 10);
  for (const r of rows) {
    const frac = r.limitKb ? r.usedKb / r.limitKb : 0;
    const color = frac > 0.9 ? BAD : frac > 0.7 ? WARN : OK;
    const meter = r.limitKb
      ? `${bar(frac, 14)} ${(Math.round(frac * 100) + '%').padEnd(8)}`
      : `${'░'.repeat(14)} ${'no limit'.padEnd(8)}`;
    ui.colored(
      `${r.user.padEnd(width)}  ${meter}  ${formatKb(r.usedKb)}${r.limitKb ? ' / ' + formatKb(r.limitKb) : ''}  ${r.messages} msg`,
      r.limitKb ? color : '#94a3b8'
    );
  }
  if (rows.length === 0) ui.line('No mailboxes.');
}

export async function toolClients(): Promise<void> {
  const clients = await loadOrError('Listing IMAP/POP sessions…', () => new OpsService().clients());
  if (!clients) return;
  ui.begin('Connected mail clients');
  if (clients.length === 0) ui.colored('Nobody is connected right now.', '#94a3b8');
  for (const c of clients) {
    ui.colored(`${c.user}  ${c.service} × ${c.connections}  from ${c.ips || '?'}`, '#38bdf8');
  }
}

export async function toolFail2ban(): Promise<void> {
  const ops = new OpsService();
  while (true) {
    const jails = await loadOrError('Reading fail2ban bans…', () => ops.banned());
    if (!jails) return;
    ui.begin('fail2ban');
    const bans = jails.flatMap((j) => j.ips.map((ip) => ({ jail: j.jail, ip })));
    for (const j of jails) {
      ui.colored(`${j.jail.padEnd(10)} ${j.ips.length === 0 ? 'no bans' : j.ips.length + ' banned'}`, j.ips.length ? BAD : OK);
    }
    if (bans.length === 0) {
      ui.success('Nobody is banned.');
      return;
    }
    const choice = await ui.select('Unban an address', [
      ...bans.map((b) => ({ value: b.ip, label: b.ip, hint: b.jail, icon: '⊘', color: BAD })),
      BACK,
    ]);
    if (isCancel(choice) || choice === 'back') return;
    const res = await ui.task(`Unbanning ${choice}…`, () => ops.unban(choice));
    reportExec(res, `${choice} unbanned`, 'Unban failed');
  }
}

export async function toolCertificate(): Promise<void> {
  const cert = await loadOrError('Reading the TLS certificate…', () => new OpsService().cert());
  ui.begin('TLS certificate');
  if (!cert) {
    ui.warn('Could not read the certificate inside the container (is the mail server running, and is MX_HOST right?).');
    return;
  }
  const color = cert.daysLeft < 14 ? BAD : cert.daysLeft < 30 ? WARN : OK;
  ui.colored(`${cert.daysLeft} days left`, color);
  ui.line(`Expires  ${cert.notAfter.toISOString().slice(0, 10)}`);
  ui.line(`Issuer   ${cert.issuer}`);
  ui.colored(bar(Math.min(1, cert.daysLeft / 90), 30), color);
  ui.info('Renewal runs from cron: scripts/renew-cert.sh (log in logs/renew-cert.log)');
}

function stage(label: string, state?: string): void {
  if (state === 'running') ui.colored(`● ${label.padEnd(12)} running`, OK);
  else if (state) ui.colored(`▲ ${label.padEnd(12)} ${state}`, WARN);
  else ui.colored(`○ ${label.padEnd(12)} not deployed`, BAD);
}

export async function toolPipeline(): Promise<void> {
  const p = await loadOrError('Checking the mail path…', () => new OpsService().pipeline());
  if (!p) return;
  ui.begin('Mail path');
  ui.heading('Inbound   sender → Cloudflare → Worker → tunnel → bridge → mailserver');
  ui.colored(
    p.mx.length ? `● MX  ${p.mx.join('  ')}` : '○ MX  none published',
    p.mx.some((m) => m.endsWith('mx.cloudflare.net')) ? OK : WARN
  );
  stage('tunnel', p.tunnel);
  stage('bridge', p.bridge);
  stage('mailserver', p.mailserver);
  ui.heading('Outbound  mailserver → Postmark → recipient');
  if (p.relayConfigured) ui.colored('● relay        POSTMARK_SERVER_TOKEN set', OK);
  else ui.colored('○ relay        no POSTMARK_SERVER_TOKEN; mail goes out directly', WARN);
}

export async function toolPostmark(): Promise<void> {
  const ops = new OpsService();
  const result = await loadOrError('Asking Postmark…', async () => ({
    stats: await ops.postmarkStats(7),
    bounces: await ops.postmarkBounces(5),
  }));
  if (!result) return;
  const { stats, bounces } = result;
  ui.begin(`Postmark · last ${stats.days} days`);
  const rate = stats.sent ? stats.bounced / stats.sent : 0;
  ui.colored(`sent ${stats.sent}`, '#38bdf8');
  ui.colored(`bounced ${stats.bounced} (${(rate * 100).toFixed(1)}%)`, stats.bounced ? (rate > 0.05 ? BAD : WARN) : OK);
  ui.colored(`spam complaints ${stats.spamComplaints}`, stats.spamComplaints ? BAD : OK);
  ui.heading('Recent bounces');
  if (bounces.length === 0) ui.colored('None.', OK);
  for (const b of bounces) {
    ui.colored(`${b.at}  ${b.email}  ${b.type}`, WARN);
    if (b.detail) ui.line(`  ${b.detail}`);
  }
}

export async function toolSendTest(): Promise<void> {
  const config = getAppConfig();
  const to = await ui.text('Send a test message to', {
    placeholder: 'you@example.com',
    validate: (v) => (!isValidEmail(v.trim()) ? 'Invalid email format' : undefined),
  });
  if (isCancel(to)) return;
  const from = config.postmasterAddress;
  const sure = await ui.confirm(`Send a test email from ${from} to ${to.trim()}?`, { initial: true });
  if (isCancel(sure) || !sure) return;
  const res = await ui.task('Sending…', () => new OpsService().sendTest(from, to.trim()));
  ui.begin('Send test');
  reportExec(res, `Queued: ${from} → ${to.trim()}. Check "Delivery log" for its status.`, 'Send failed');
}
