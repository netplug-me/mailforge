import { getAppConfig } from '../config.js';
import { DomainManager } from '../services/domain-manager.js';
import { DmsService } from '../services/dms.js';
import { DkimService } from '../services/dkim.js';
import { CloudflareService } from '../services/cloudflare.js';
import type { ExecResult } from '../services/docker.js';
import { MailboxAlias } from '../types.js';
import { isValidDomain, isValidEmail } from '../utils/validator.js';
import { refreshDashboard, refreshLocal, refreshUsage } from './dashboard.js';
import { generatePassword } from './theme.js';
import { isCancel, OutputLine, ui } from './ui.js';

// Each flow is one user task: it collects input in a single dialog, does the work, reports
// the result as a toast (or a dialog when the user must read or copy something), and
// refreshes whatever data changed.

export interface FlowContext {
  dm: DomainManager;
  dms: DmsService;
}

const LOCAL_PART = /^[a-z0-9][a-z0-9._+-]*$/i;
const QUOTA = /^\d+[BKMGT]$/i;

const failure = (r: ExecResult) => (r.stderr || r.stdout).trim().split('\n').pop() || `exit code ${r.code}`;

const parseUsers = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);

function validateUsers(value: string): string | undefined {
  const users = parseUsers(value);
  if (users.length === 0) return 'Enter at least one name';
  const bad = users.find((u) => !LOCAL_PART.test(u));
  if (bad) return `"${bad}" is not a valid mailbox name`;
}

const validateQuota = (v: string) => (v.trim() && !QUOTA.test(v.trim()) ? 'Use a size such as 500M or 2G' : undefined);

function clientSettings(): OutputLine[] {
  const { mxHost } = getAppConfig();
  return [
    { kind: 'heading', text: 'Mail app settings' },
    { kind: 'text', text: 'Username   the full address' },
    { kind: 'text', text: `Incoming   ${mxHost}  IMAP ${993}  SSL/TLS` },
    { kind: 'text', text: `Outgoing   ${mxHost}  SMTP 587  STARTTLS  (or 465 SSL/TLS)` },
  ];
}

function domainOptions(ctx: FlowContext) {
  return ctx.dm.getAllDomains().map((d) => ({ value: d, label: d }));
}

/** Puts `first` at the front so a select field starts on it. */
function defaultDomain(ctx: FlowContext, preferred?: string): string {
  const all = ctx.dm.getAllDomains();
  return preferred && all.includes(preferred) ? preferred : all[0];
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

interface Created {
  email: string;
  password: string;
  generated: boolean;
  /** Dovecot accepted a test login with this password. */
  verified?: boolean;
}

/** Creates the mailboxes, generating a password for each one that was not given one. */
async function createMailboxes(
  ctx: FlowContext,
  domain: string,
  users: string[],
  password: string,
  quota: string
): Promise<{ created: Created[]; errors: string[] }> {
  const existing = new Set(ctx.dms.listAccounts().map((a) => a.email.toLowerCase()));
  const created: Created[] = [];
  const errors: string[] = [];
  for (const user of users) {
    const email = `${user}@${domain}`;
    if (existing.has(email)) {
      errors.push(`${email} already exists; left unchanged`);
      continue;
    }
    const pw = password || generatePassword();
    const res = await ctx.dms.runSetupAsync(['email', 'add', email, pw]);
    if (!res.success) {
      errors.push(`${email}: ${failure(res)}`);
      continue;
    }
    created.push({ email, password: pw, generated: !password });
    if (quota) {
      const q = await ctx.dms.runSetupAsync(['quota', 'set', email, quota]);
      if (!q.success) errors.push(`quota for ${email}: ${failure(q)}`);
    }
  }
  return { created, errors };
}

/** Polls until Dovecot accepts the login (it notices account changes a few seconds late). */
async function waitForLogin(ctx: FlowContext, email: string, password: string, timeoutMs = 25000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await ctx.dms.verifyLogin(email, password)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function credentialsNotice(created: Created[], errors: string[]): OutputLine[] {
  const lines: OutputLine[] = [];
  if (created.length > 0) {
    lines.push({ kind: 'success', text: `Created ${created.length} mailbox${created.length === 1 ? '' : 'es'}` });
    lines.push({ kind: 'heading', text: 'Login details (shown once; not stored)' });
    const width = Math.max(...created.map((c) => c.email.length));
    for (const c of created) {
      lines.push({ kind: 'raw', text: `${c.email.padEnd(width)}  ${c.password}${c.generated ? '' : '  (the password you entered)'}` });
    }
    const pending = created.filter((c) => c.verified === false);
    if (created.some((c) => c.verified)) lines.push({ kind: 'success', text: `Test login accepted for ${created.filter((c) => c.verified).length} mailbox(es)` });
    if (pending.length > 0) lines.push({ kind: 'warn', text: `Not accepting logins yet: ${pending.map((c) => c.email).join(', ')}. The server picks up new mailboxes after a few seconds.` });
  }
  for (const e of errors) lines.push({ kind: 'warn', text: e });
  if (created.length > 0) lines.push(...clientSettings());
  return lines;
}

export async function addMailboxFlow(ctx: FlowContext, preferredDomain?: string): Promise<void> {
  const v = await ui.form('Add mailboxes', [
    {
      kind: 'select',
      key: 'domain',
      label: 'Domain',
      options: domainOptions(ctx),
      initial: defaultDomain(ctx, preferredDomain),
    },
    {
      kind: 'text',
      key: 'users',
      label: 'Name(s)',
      placeholder: 'sales, support',
      hint: 'Comma separated: one mailbox per name, before the @',
      validate: validateUsers,
    },
    {
      kind: 'text',
      key: 'password',
      label: 'Password',
      mask: true,
      placeholder: '(generate one per mailbox)',
      hint: 'Leave empty to generate a strong password for each mailbox',
      validate: (p) => (p && p.length < 8 ? 'At least 8 characters' : undefined),
    },
    {
      kind: 'text',
      key: 'quota',
      label: 'Quota',
      placeholder: '(default)',
      hint: 'e.g. 500M or 2G; empty keeps the server default',
      validate: validateQuota,
    },
  ], { submitLabel: 'Create' });
  if (isCancel(v)) return;

  const users = parseUsers(String(v.users));
  const { created, errors } = await ui.task(`Creating ${users.length} mailbox(es)…`, async () => {
    const result = await createMailboxes(ctx, String(v.domain), users, String(v.password), String(v.quota).trim().toUpperCase());
    ui.setBusy('Waiting for the mail server to accept the new logins…');
    await Promise.all(result.created.map(async (c) => { c.verified = await waitForLogin(ctx, c.email, c.password); }));
    return result;
  });
  await refreshLocal(ctx.dm);
  void refreshUsage();
  if (created.length === 0) {
    ui.toast('error', errors[0] ?? 'No mailbox was created');
    return;
  }
  await ui.notice('Mailboxes created', credentialsNotice(created, errors));
}

export async function deleteAccountFlow(ctx: FlowContext, email: string): Promise<void> {
  const v = await ui.form(`Delete ${email}`, [
    {
      kind: 'toggle',
      key: 'data',
      label: 'Delete stored mail',
      initial: false,
      hint: 'Off: the mailbox is removed but its mail stays on disk (re-adding the address brings it back)',
    },
  ], { submitLabel: 'Delete', danger: true });
  if (isCancel(v)) return;
  const res = await ui.task(`Deleting ${email}…`, () => ctx.dms.runSetupAsync(['email', 'del', email]));
  if (!res.success) {
    await refreshLocal(ctx.dm);
    ui.toast('error', `Could not delete ${email}: ${failure(res)}`);
    return;
  }
  let note = 'its stored mail was kept';
  if (v.data) {
    const wiped = await ui.task('Deleting stored mail…', () => ctx.dms.deleteMailData(email));
    note = wiped.success ? 'its stored mail was deleted' : `stored mail NOT deleted: ${failure(wiped)}`;
  }
  await refreshLocal(ctx.dm);
  ui.toast(v.data && note.startsWith('stored mail NOT') ? 'warn' : 'success', `Deleted ${email}; ${note}`);
}

export async function resetPasswordFlow(ctx: FlowContext, email: string): Promise<void> {
  const v = await ui.form(`New password for ${email}`, [
    {
      kind: 'text',
      key: 'password',
      label: 'Password',
      mask: true,
      placeholder: '(generate one)',
      hint: 'Leave empty to generate a strong password',
      validate: (p) => (p && p.length < 8 ? 'At least 8 characters' : undefined),
    },
  ], { submitLabel: 'Change' });
  if (isCancel(v)) return;
  const given = String(v.password);
  const password = given || generatePassword();
  const res = await ui.task(`Changing the password for ${email}…`, () =>
    ctx.dms.runSetupAsync(['email', 'update', email, password])
  );
  if (!res.success) {
    ui.toast('error', `Could not change the password: ${failure(res)}`);
    return;
  }
  const verified = await ui.task('Waiting for the mail server to accept the new password…', () => waitForLogin(ctx, email, password));
  if (given) ui.toast(verified ? 'success' : 'warn', verified ? `Password for ${email} changed` : `Password for ${email} changed; the server has not picked it up yet`);
  else {
    await ui.notice('Password changed', [
      { kind: 'success', text: `New password for ${email}` },
      { kind: 'raw', text: password },
      verified
        ? { kind: 'success', text: 'Test login accepted.' }
        : { kind: 'warn', text: 'Not accepted yet; the server picks changes up after a few seconds.' },
      { kind: 'info', text: 'Shown once; it is not stored anywhere.' },
    ]);
  }
}

export async function setQuotaFlow(ctx: FlowContext, email: string, current?: string): Promise<void> {
  const v = await ui.form(`Quota for ${email}`, [
    {
      kind: 'text',
      key: 'quota',
      label: 'Quota',
      initial: current ?? '',
      placeholder: '2G',
      hint: "e.g. 500M or 2G; type 'none' to remove the limit",
      validate: (q) => {
        const t = q.trim();
        if (!t) return 'Enter a size, or "none" to remove the limit';
        if (t.toLowerCase() !== 'none') return validateQuota(t);
      },
    },
  ], { submitLabel: 'Set' });
  if (isCancel(v)) return;
  const quota = String(v.quota).trim();
  const none = quota.toLowerCase() === 'none';
  const res = await ui.task(`Setting the quota for ${email}…`, () =>
    ctx.dms.runSetupAsync(none ? ['quota', 'del', email] : ['quota', 'set', email, quota.toUpperCase()])
  );
  void refreshUsage();
  if (res.success) ui.toast('success', none ? `Removed the quota for ${email}` : `Quota for ${email} is now ${quota.toUpperCase()}`);
  else ui.toast('error', `Could not set the quota: ${failure(res)}`);
}

// ── Aliases ──────────────────────────────────────────────────────────────────

export async function addAliasFlow(ctx: FlowContext, preferredDomain?: string): Promise<void> {
  const v = await ui.form('Add alias / forwarder', [
    {
      kind: 'select',
      key: 'domain',
      label: 'Domain',
      options: domainOptions(ctx),
      initial: defaultDomain(ctx, preferredDomain),
    },
    {
      kind: 'text',
      key: 'name',
      label: 'Alias name',
      placeholder: 'support',
      validate: (n) => (!LOCAL_PART.test(n.trim()) ? 'Enter a valid name, before the @' : undefined),
    },
    {
      kind: 'text',
      key: 'dest',
      label: 'Delivers to',
      placeholder: 'someone@example.com',
      hint: 'A mailbox here or an external address',
      validate: (d) => (!isValidEmail(d.trim()) ? 'Invalid email address' : undefined),
    },
  ], { submitLabel: 'Add' });
  if (isCancel(v)) return;
  const source = `${String(v.name).trim().toLowerCase()}@${v.domain}`;
  const dest = String(v.dest).trim();
  const res = await ui.task(`Adding ${source} → ${dest}…`, () => ctx.dms.runSetupAsync(['alias', 'add', source, dest]));
  await refreshLocal(ctx.dm);
  if (res.success) ui.toast('success', `${source} now forwards to ${dest}`);
  else ui.toast('error', `Could not add the alias: ${failure(res)}`);
}

export async function deleteAliasFlow(ctx: FlowContext, alias: MailboxAlias): Promise<void> {
  const sure = await ui.confirm(`Delete the alias ${alias.source} → ${alias.destination}?`, { danger: true });
  if (isCancel(sure) || !sure) return;
  const res = await ui.task(`Deleting ${alias.source}…`, () =>
    ctx.dms.runSetupAsync(['alias', 'del', alias.source, alias.destination])
  );
  await refreshLocal(ctx.dm);
  if (res.success) ui.toast('success', `Deleted the alias ${alias.source}`);
  else ui.toast('error', `Could not delete the alias: ${failure(res)}`);
}

// ── Domains ──────────────────────────────────────────────────────────────────

export async function addDomainFlow(ctx: FlowContext): Promise<void> {
  const config = getAppConfig();
  const cf = new CloudflareService();
  const v = await ui.form('Add domain / sub-domain', [
    {
      kind: 'text',
      key: 'domain',
      label: 'Domain',
      placeholder: 'shop.example.com',
      validate: (val) => {
        const d = val.trim().toLowerCase();
        if (!d) return 'Domain cannot be empty';
        if (!isValidDomain(d)) return 'Invalid domain format';
        if (d === config.primaryDomain) return 'Cannot add the primary domain';
        if (ctx.dm.getAllDomains().includes(d)) return 'Domain is already registered';
      },
    },
    {
      kind: 'text',
      key: 'users',
      label: 'Mailboxes',
      placeholder: '(optional) sales, support',
      hint: 'Comma separated. A domain only accepts mail once it has a mailbox or alias.',
      validate: (u) => (u.trim() ? validateUsers(u) : undefined),
    },
    {
      kind: 'text',
      key: 'forward',
      label: 'Forward to',
      placeholder: '(optional) you@gmail.com',
      hint: 'If set, the names above become forwarders to this address instead of mailboxes',
      validate: (f) => (f.trim() && !isValidEmail(f.trim()) ? 'Invalid email address' : undefined),
    },
    {
      kind: 'text',
      key: 'password',
      label: 'Password',
      mask: true,
      placeholder: '(generate one per mailbox)',
      validate: (p) => (p && p.length < 8 ? 'At least 8 characters' : undefined),
    },
    { kind: 'text', key: 'quota', label: 'Quota', placeholder: '(default)', validate: validateQuota },
    ...(cf.isConfigured()
      ? [{ kind: 'toggle' as const, key: 'dns', label: 'Publish DNS', initial: false, hint: 'MX → the mail host, SPF, DKIM, DMARC. Leave off for zones that use Email Routing.' }]
      : []),
  ], { submitLabel: 'Add domain' });
  if (isCancel(v)) return;

  const domain = String(v.domain).trim().toLowerCase();
  const users = parseUsers(String(v.users));
  const forward = String(v.forward).trim();

  const outcome = await ui.task(`Adding ${domain}…`, async () => {
    const res = await ctx.dm.addDomain({
      domain,
      users: forward ? users : [],
      forward: forward || undefined,
      syncDns: Boolean(v.dns),
    });
    ui.setBusy('Creating mailboxes…');
    const boxes = !forward && users.length > 0
      ? await createMailboxes(ctx, domain, users, String(v.password), String(v.quota).trim().toUpperCase())
      : { created: [], errors: [] };
    return { res, boxes };
  });
  await refreshLocal(ctx.dm);
  void refreshDashboard(ctx.dm);

  const { res, boxes } = outcome;
  const lines: OutputLine[] = [
    { kind: 'success', text: `${domain} added` },
    { kind: 'text', text: `DKIM key: ${res.dkimGenerated ? 'generated' : 'not generated'}` },
  ];
  if (res.aliasesAdded.length > 0) lines.push({ kind: 'text', text: `Forwarders: ${res.aliasesAdded.join(', ')}` });
  if (res.dnsSyncResult) {
    lines.push({ kind: 'text', text: `Cloudflare zone ${res.dnsSyncResult.zone.name}: ${res.dnsSyncResult.results.length} records synchronized` });
  }
  for (const e of [...res.errors, ...boxes.errors]) lines.push({ kind: 'warn', text: e });
  if (boxes.created.length > 0) lines.push(...credentialsNotice(boxes.created, []).slice(1));
  if (res.dkimValue && !v.dns) {
    lines.push({ kind: 'heading', text: 'DKIM TXT value' });
    lines.push({ kind: 'raw', text: res.dkimValue });
  }
  await ui.notice(`Domain ${domain}`, lines);
}

export async function removeDomainFlow(ctx: FlowContext, domain: string): Promise<void> {
  const config = getAppConfig();
  if (domain === config.primaryDomain) {
    ui.toast('warn', 'The primary domain cannot be removed');
    return;
  }
  const cf = new CloudflareService();
  const v = await ui.form(`Remove ${domain}`, [
    { kind: 'toggle', key: 'data', label: 'Delete stored mail', initial: false, hint: 'Permanently deletes the mail on disk for this domain' },
    ...(cf.isConfigured()
      ? [{ kind: 'toggle' as const, key: 'dns', label: 'Delete DNS records', initial: false, hint: 'MX, SPF, DKIM, DMARC named exactly this domain; on an apex that includes Email Routing MX and the Postmark SPF' }]
      : []),
  ], { submitLabel: 'Continue', danger: true });
  if (isCancel(v)) return;
  const sure = await ui.confirm(`Remove ${domain}? Its mailboxes are deleted and it stops accepting email.`, { danger: true });
  if (isCancel(sure) || !sure) return;

  const res = await ui.task(`Removing ${domain}…`, () =>
    ctx.dm.removeDomain({ domain, deleteData: Boolean(v.data), deleteDns: Boolean(v.dns) })
  );
  await refreshLocal(ctx.dm);
  void refreshDashboard(ctx.dm);
  const lines: OutputLine[] = [
    { kind: res.errors.length ? 'warn' : 'success', text: res.errors.length ? `${domain} removed with problems` : `${domain} removed` },
    { kind: 'text', text: `Mailboxes deleted: ${res.accountsDeleted.length}` },
  ];
  if (res.dataDeleted) lines.push({ kind: 'text', text: 'Stored mail: deleted' });
  if (res.dnsDeletedResult) lines.push({ kind: 'text', text: `Cloudflare records deleted: ${res.dnsDeletedResult.deletedCount}` });
  for (const e of res.errors) lines.push({ kind: 'warn', text: e });
  await ui.notice(`Domain ${domain}`, lines);
}

export async function syncDnsFlow(ctx: FlowContext, domain: string): Promise<void> {
  const cf = new CloudflareService();
  if (!cf.isConfigured()) {
    ui.toast('warn', 'Set CF_API_TOKEN in .env to publish DNS records');
    return;
  }
  const sure = await ui.confirm(`Publish MX, SPF, DKIM and DMARC for ${domain} to Cloudflare?`, { initial: true });
  if (isCancel(sure) || !sure) return;
  const res = await ui.task(`Publishing DNS records for ${domain}…`, () => ctx.dm.syncDns(domain));
  void refreshDashboard(ctx.dm);
  const lines: OutputLine[] = res.results.map((r: any) =>
    r.error
      ? { kind: 'error', text: `${r.recordType} ${r.name}: ${r.error}` }
      : { kind: 'success', text: `${r.recordType} ${r.name}: ${r.action}` }
  );
  await ui.notice(`Cloudflare sync · ${domain}`, lines);
}

export async function dkimFlow(ctx: FlowContext, domain: string, regenerate = false): Promise<void> {
  const config = getAppConfig();
  const dkim = new DkimService();
  let info = dkim.getDkimInfo(domain, config.dkimSelector);

  if (!info.exists || regenerate) {
    const sure = await ui.confirm(
      regenerate
        ? `Replace the DKIM key for ${domain}? The published DNS record must be updated afterwards.`
        : `No DKIM key exists for ${domain}. Generate one?`,
      { danger: regenerate, initial: true }
    );
    if (isCancel(sure) || !sure) return;
    const res = await ui.task(`Generating the DKIM key for ${domain}…`, () =>
      ctx.dms.runSetupAsync(['config', 'dkim', 'selector', config.dkimSelector, 'keysize', '2048', 'domain', domain])
    );
    if (!res.success) {
      ui.toast('error', `DKIM generation failed: ${failure(res)}`);
      return;
    }
    info = dkim.getDkimInfo(domain, config.dkimSelector);
    await refreshLocal(ctx.dm);
  }

  const lines: OutputLine[] = [
    { kind: 'text', text: `Selector   ${config.dkimSelector}` },
    { kind: info.exists ? 'success' : 'error', text: info.exists ? 'Key found on disk' : 'No key on disk' },
  ];
  if (info.filePath) lines.push({ kind: 'text', text: `Path       ${info.filePath}` });
  if (info.dnsValue) {
    lines.push({ kind: 'text', text: `DNS host   ${config.dkimSelector}._domainkey.${domain}  (TXT)` });
    lines.push({ kind: 'heading', text: 'TXT value' });
    lines.push({ kind: 'raw', text: info.dnsValue });
    lines.push({ kind: 'info', text: `To copy without line wraps: ./mailforge dkim ${domain}` });
  }
  await ui.notice(`DKIM · ${domain}`, lines);
}
