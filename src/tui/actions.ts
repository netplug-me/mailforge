import { getAppConfig } from '../config.js';
import { DomainManager } from '../services/domain-manager.js';
import { DmsService } from '../services/dms.js';
import { DockerService, ExecResult } from '../services/docker.js';
import { DkimService } from '../services/dkim.js';
import { DnsCheckerService } from '../services/dns.js';
import { CloudflareService } from '../services/cloudflare.js';
import { OpsService, formatKb } from '../services/ops.js';
import { DnsCheckItem } from '../types.js';
import { isValidDomain, isValidEmail } from '../utils/validator.js';
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

function pickDomain(dm: DomainManager, message: string) {
  return ui.select(
    message,
    dm.getAllDomains().map((d) => ({ value: d, label: d }))
  );
}

export async function actionAddDomain(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const cf = new CloudflareService();

  const domainInput = await ui.text('Domain or sub-domain to add', {
    placeholder: 'shop.example.com',
    validate: (val) => {
      const d = val.trim().toLowerCase();
      if (!d) return 'Domain cannot be empty';
      if (!isValidDomain(d)) return 'Invalid domain format';
      if (d === config.primaryDomain) return 'Cannot add the primary domain';
      if (dm.getAllDomains().includes(d)) return 'Domain is already registered';
    },
  });
  if (isCancel(domainInput)) return;
  const domain = domainInput.trim().toLowerCase();

  const usersInput = await ui.text('Initial email user(s), comma separated (optional)', {
    placeholder: 'sales, support',
  });
  if (isCancel(usersInput)) return;

  const users = usersInput
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  let password = '';
  let quota = '';
  let forward = '';

  if (users.length > 0) {
    const isForward = await ui.confirm('Forward these users to an external address instead of creating mailboxes?');
    if (isCancel(isForward)) return;

    if (isForward) {
      const fwd = await ui.text('Destination email address for forwarding', {
        placeholder: 'you@gmail.com',
        validate: (val) => (!isValidEmail(val.trim()) ? 'Invalid email format' : undefined),
      });
      if (isCancel(fwd)) return;
      forward = fwd.trim();
    } else {
      const pwd = await ui.text('Initial password for the new accounts (empty = DMS prompts)', { mask: true });
      if (isCancel(pwd)) return;
      password = pwd;

      const q = await ui.text('Mailbox quota (e.g. 500M, 2G; empty = default)', { placeholder: '1G' });
      if (isCancel(q)) return;
      quota = q.trim();
    }
  }

  let syncDns = false;
  if (cf.isConfigured()) {
    const sync = await ui.confirm('Publish MX, SPF, DKIM and DMARC records to Cloudflare?', { initial: true });
    if (isCancel(sync)) return;
    syncDns = sync;
  }

  try {
    const res = await ui.task(`Adding domain ${domain}…`, () =>
      dm.addDomain({
        domain,
        users,
        password: password || undefined,
        quota: quota || undefined,
        forward: forward || undefined,
        syncDns,
      })
    );

    ui.success(`Domain ${domain} added`);
    ui.line('Registered in POSTFIX_VIRTUAL_DOMAINS');
    ui.line(`DKIM key generated: ${res.dkimGenerated ? 'yes' : 'no'}`);
    if (res.accountsAdded.length > 0) ui.line(`Accounts: ${res.accountsAdded.join(', ')}`);
    if (res.dnsSyncResult) {
      ui.line(
        `Cloudflare zone ${res.dnsSyncResult.zone.name}: ${res.dnsSyncResult.results.length} records synchronized`
      );
    }
    if (res.dkimValue) {
      ui.heading('DKIM TXT value');
      ui.raw(res.dkimValue);
    }
  } catch (err: any) {
    ui.error(`Failed to add domain: ${err.message}`);
  }
}

export async function actionRemoveDomain(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const cf = new CloudflareService();

  const virtualDomains = dm.getAllDomains().filter((d) => d !== config.primaryDomain);
  if (virtualDomains.length === 0) {
    ui.warn('No virtual domains to remove (the primary domain cannot be removed).');
    return;
  }

  const domain = await ui.select(
    'Domain to remove',
    virtualDomains.map((d) => ({ value: d, label: d }))
  );
  if (isCancel(domain)) return;

  const deleteData = await ui.confirm(`Permanently delete stored mail for ${domain}?`);
  if (isCancel(deleteData)) return;

  let deleteDns = false;
  if (cf.isConfigured()) {
    const dnsConfirm = await ui.confirm(`Delete MX, SPF, DKIM and DMARC records for ${domain} from Cloudflare?`, {
      initial: true,
    });
    if (isCancel(dnsConfirm)) return;
    deleteDns = dnsConfirm;
  }

  const confirmed = await ui.confirm(`Remove ${domain}? It will stop accepting email.`, { danger: true });
  if (isCancel(confirmed) || !confirmed) {
    ui.info('Cancelled; nothing was changed.');
    return;
  }

  try {
    const res = await ui.task(`Removing domain ${domain}…`, () => dm.removeDomain({ domain, deleteData, deleteDns }));
    ui.success(`Domain ${domain} removed`);
    ui.line(`Accounts purged: ${res.accountsDeleted.length}`);
    if (res.dataDeleted) ui.line('Mail data: deleted');
    if (res.dnsDeletedResult) ui.line(`Cloudflare records deleted: ${res.dnsDeletedResult.deletedCount}`);
  } catch (err: any) {
    ui.error(`Failed to remove domain: ${err.message}`);
  }
}

export async function actionManageMailboxes(dm: DomainManager): Promise<void> {
  const dms = new DmsService();

  const domain = await pickDomain(dm, 'Domain to manage mailboxes & aliases for');
  if (isCancel(domain)) return;

  // Outcome of the previous step, shown under the refreshed listing.
  let result: (() => void) | undefined;

  while (true) {
    const accounts = dms.listAccounts().filter((a) => a.domain.toLowerCase() === domain.toLowerCase());
    const aliases = dms.listAliases().filter((a) => a.source.toLowerCase().endsWith(`@${domain.toLowerCase()}`));

    ui.begin(`Mailboxes & aliases · ${domain}`);
    if (accounts.length === 0 && aliases.length === 0) {
      ui.line('(no mailboxes or aliases yet)');
    }
    for (const a of accounts) ui.line(`mailbox  ${a.email}`);
    for (const al of aliases) ui.line(`alias    ${al.source} → ${al.destination}`);
    result?.();
    result = undefined;

    const action = await ui.select('Mailbox action', [
      { value: 'add_account', label: 'Add email account' },
      { value: 'del_account', label: 'Delete email account' },
      { value: 'set_quota', label: 'Set mailbox quota' },
      { value: 'add_alias', label: 'Add forwarder / alias' },
      { value: 'del_alias', label: 'Delete forwarder / alias' },
      BACK,
    ]);

    if (isCancel(action) || action === 'back') break;

    if (action === 'add_account') {
      const username = await ui.text(`Username for the new account (@${domain})`, {
        placeholder: 'john',
        validate: (v) => (!v.trim() ? 'Username cannot be empty' : undefined),
      });
      if (isCancel(username)) continue;

      const password = await ui.text('Password for the new account', { mask: true });
      if (isCancel(password)) continue;

      const email = `${username.trim()}@${domain}`;
      const res = await ui.task(`Adding account ${email}…`, () => dms.addAccount(email, password.trim() || undefined));
      result = () => reportExec(res, `Account ${email} created`, 'Failed to create account');
    } else if (action === 'del_account') {
      if (accounts.length === 0) {
        result = () => ui.warn('No accounts to delete.');
      } else {
        const target = await ui.select(
          'Account to delete',
          accounts.map((a) => ({ value: a.email, label: a.email }))
        );
        if (isCancel(target)) continue;
        const sure = await ui.confirm(`Delete ${target}?`, { danger: true });
        if (isCancel(sure) || !sure) continue;

        const res = await ui.task(`Deleting ${target}…`, () => dms.delAccount(target));
        result = () => reportExec(res, `Account ${target} deleted`, 'Failed to delete account');
      }
    } else if (action === 'set_quota') {
      if (accounts.length === 0) {
        result = () => ui.warn('No accounts exist.');
      } else {
        const target = await ui.select(
          'Account',
          accounts.map((a) => ({ value: a.email, label: a.email }))
        );
        if (isCancel(target)) continue;

        const quota = await ui.text('Quota size (e.g. 500M, 2G)', { placeholder: '1G' });
        if (isCancel(quota)) continue;

        const res = await ui.task(`Setting quota for ${target}…`, () => dms.setQuota(target, quota.trim()));
        result = () => reportExec(res, `Quota for ${target} set to ${quota.trim()}`, 'Failed to set quota');
      }
    } else if (action === 'add_alias') {
      const srcUser = await ui.text(`Alias name (@${domain})`, {
        placeholder: 'support',
        validate: (v) => (!v.trim() ? 'Alias name cannot be empty' : undefined),
      });
      if (isCancel(srcUser)) continue;

      const dest = await ui.text('Destination address', {
        placeholder: 'user@external.com',
        validate: (v) => (!isValidEmail(v.trim()) ? 'Invalid email format' : undefined),
      });
      if (isCancel(dest)) continue;

      const srcEmail = `${srcUser.trim()}@${domain}`;
      const res = await ui.task(`Adding alias ${srcEmail} → ${dest.trim()}…`, () =>
        dms.addAlias(srcEmail, dest.trim())
      );
      result = () => reportExec(res, `Alias ${srcEmail} → ${dest.trim()} created`, 'Failed to create alias');
    } else if (action === 'del_alias') {
      if (aliases.length === 0) {
        result = () => ui.warn('No aliases exist.');
      } else {
        const target = await ui.select(
          'Alias to delete',
          aliases.map((al) => ({ value: al, label: `${al.source} → ${al.destination}` }))
        );
        if (isCancel(target)) continue;

        const res = await ui.task(`Deleting alias ${target.source}…`, () =>
          dms.delAlias(target.source, target.destination)
        );
        result = () => reportExec(res, `Alias ${target.source} deleted`, 'Failed to delete alias');
      }
    }
  }
}

export async function actionViewDkim(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const dkim = new DkimService();
  const dms = new DmsService();
  const cf = new CloudflareService();

  const domain = await pickDomain(dm, 'Domain to inspect DKIM keys for');
  if (isCancel(domain)) return;

  const show = () => {
    const info = dkim.getDkimInfo(domain, config.dkimSelector);
    ui.begin(`DKIM · ${domain}`);
    ui.line(`Selector  ${config.dkimSelector}`);
    ui.line(`Status    ${info.exists ? '● key found on disk' : '○ not generated'}`);
    if (info.filePath) ui.line(`Path      ${info.filePath}`);
    if (info.dnsValue) {
      ui.line(`DNS host  ${config.dkimSelector}._domainkey.${domain}  (TXT)`);
      ui.heading('TXT value');
      ui.raw(info.dnsValue);
      ui.info(`To copy without line wraps: ./mailctl dkim ${domain}`);
    }
    return info;
  };

  const info = show();

  const options: { value: string; label: string }[] = [];
  if (!info.exists) {
    options.push({ value: 'generate', label: 'Generate DKIM key' });
  } else {
    if (cf.isConfigured()) options.push({ value: 'sync_cf', label: 'Publish DKIM to Cloudflare' });
    options.push({ value: 'regenerate', label: 'Regenerate DKIM key' });
  }
  options.push(BACK);

  const choice = await ui.select('DKIM action', options);
  if (isCancel(choice) || choice === 'back') return;

  if (choice === 'generate' || choice === 'regenerate') {
    if (choice === 'regenerate') {
      const sure = await ui.confirm('Regenerating replaces the key; the published DNS record must be updated. Continue?', {
        danger: true,
      });
      if (isCancel(sure) || !sure) return;
    }
    const res = await ui.task(`Generating DKIM key for ${domain}…`, () => dms.generateDkim(domain, config.dkimSelector));
    show();
    reportExec(res, 'DKIM key generated', 'Failed to generate DKIM key');
  } else if (choice === 'sync_cf') {
    try {
      await ui.task('Publishing DKIM record to Cloudflare…', () => dm.syncDns(domain));
      ui.success('DKIM published to Cloudflare');
    } catch (err: any) {
      ui.error(`Failed to publish DKIM: ${err.message}`);
    }
  }
}

export async function actionDnsOperations(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const checker = new DnsCheckerService();
  const cf = new CloudflareService();

  const domain = await pickDomain(dm, 'Domain for DNS operations');
  if (isCancel(domain)) return;

  const status = await ui.task(`Querying live DNS for ${domain}…`, () =>
    checker.checkAll(domain, config.mxHost, config.dkimSelector)
  );

  ui.begin(`DNS health · ${domain}`);
  const addItem = (title: string, item: DnsCheckItem) => {
    const line = `${title}: ${item.status}`;
    if (item.status === 'valid') ui.success(line);
    else if (item.status === 'invalid') ui.warn(line);
    else if (item.status === 'missing') ui.error(line);
    else ui.info(line);
    ui.line(`  found:    ${item.records.length > 0 ? item.records.join(', ') : '<none>'}`);
    if (item.expected) ui.line(`  expected: ${item.expected}`);
  };

  addItem('MX', status.mx);
  addItem('SPF', status.spf);
  addItem(`DKIM (${config.dkimSelector}._domainkey.${domain})`, status.dkim);
  addItem(`DMARC (_dmarc.${domain})`, status.dmarc);

  if (!cf.isConfigured()) return;

  const choice = await ui.select('DNS action', [
    { value: 'sync', label: 'Sync all 4 records to Cloudflare' },
    BACK,
  ]);
  if (isCancel(choice) || choice === 'back') return;

  try {
    const res = await ui.task(`Synchronizing DNS records for ${domain} to Cloudflare…`, () => dm.syncDns(domain));
    ui.begin(`Cloudflare sync · ${domain}`);
    for (const item of res.results) {
      if (item.error) ui.error(`${item.recordType} ${item.name}: ${item.error}`);
      else ui.success(`${item.recordType} ${item.name}: ${item.action}`);
    }
  } catch (err: any) {
    ui.error(`Sync failed: ${err.message}`);
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

// ── Toolbox ──────────────────────────────────────────────────────────────────

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
    const meter = r.limitKb ? `${bar(frac, 14)} ${Math.round(frac * 100)}%` : `${'░'.repeat(14)} no limit`;
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
      ...bans.map((b) => ({ value: b.ip, label: b.ip, hint: b.jail, icon: '⛔', color: BAD })),
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

export async function actionToolbox(): Promise<void> {
  while (true) {
    const choice = await ui.select('Toolbox', [
      { value: 'queue', label: 'Mail queue', icon: '▤', color: '#fbbf24', hint: 'retry / purge' },
      { value: 'log', label: 'Delivery log', icon: '≋', color: '#38bdf8', hint: 'sent / deferred / bounced' },
      { value: 'quotas', label: 'Mailbox usage', icon: '▰', color: '#4ade80', hint: 'quota bars' },
      { value: 'clients', label: 'Connected clients', icon: '◉', color: '#2dd4bf' },
      { value: 'f2b', label: 'fail2ban', icon: '⛔', color: '#f87171', hint: 'bans & unban' },
      { value: 'cert', label: 'TLS certificate', icon: '⚿', color: '#a78bfa', hint: 'expiry' },
      { value: 'path', label: 'Mail path', icon: '⇄', color: '#818cf8', hint: 'inbound & outbound' },
      { value: 'postmark', label: 'Postmark stats', icon: '✉', color: '#f472b6', hint: 'bounces' },
      { value: 'test', label: 'Send test email', icon: '➤', color: '#4ade80' },
      BACK,
    ]);
    if (isCancel(choice) || choice === 'back') return;
    const tool = {
      queue: toolMailQueue,
      log: toolDeliveryLog,
      quotas: toolQuotas,
      clients: toolClients,
      f2b: toolFail2ban,
      cert: toolCertificate,
      path: toolPipeline,
      postmark: toolPostmark,
      test: toolSendTest,
    }[choice as 'queue'];
    try {
      await tool();
    } catch (err: any) {
      ui.error(err?.message ?? String(err));
    }
  }
}
