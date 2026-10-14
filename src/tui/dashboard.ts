import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAppConfig } from '../config.js';
import { DockerService } from '../services/docker.js';
import { CloudflareService } from '../services/cloudflare.js';
import { DmsService } from '../services/dms.js';
import { DomainManager } from '../services/domain-manager.js';
import { ContainerStats, OpsService, QuotaRow, parseContainerStats } from '../services/ops.js';
import { DomainInfo } from '../types.js';
import { Health, ui } from './ui.js';

const execFileP = promisify(execFile);

let refreshSeq = 0;

/**
 * Fast refresh from local files only (accounts, aliases, registered domains, container state).
 * Keeps the last known DNS result for each domain, so it can run after every edit without
 * waiting for live DNS.
 */
export async function refreshLocal(dm: DomainManager): Promise<void> {
  const previous = ui.getState().dashboard;
  const dms = new DmsService();
  const known = new Map(previous.domains.map((d) => [d.domain, d]));
  const domains: DomainInfo[] = await dm.listDomains(false);
  ui.patchDashboard({
    domains: domains.map((d) => ({ ...d, dnsStatus: known.get(d.domain)?.dnsStatus ?? d.dnsStatus })),
    accounts: dms.listAccounts(),
    aliases: dms.listAliases(),
    containerStatus: new DockerService().getContainerStatus(),
  });
}

/** Mailbox usage from Dovecot; undefined when the mail server is not answering. */
async function loadUsage(): Promise<Record<string, QuotaRow> | undefined> {
  try {
    const rows = await new OpsService().quotas();
    return Object.fromEntries(rows.map((r) => [r.user.toLowerCase(), r]));
  } catch {
    return undefined;
  }
}

/** Refreshes only the per-mailbox usage numbers. */
export async function refreshUsage(): Promise<void> {
  const usage = await loadUsage();
  if (usage) ui.patchDashboard({ usage });
}

/**
 * Re-reads everything: local state first (so the screens are usable straight away), then
 * container health, Cloudflare zones, usage and live DNS for every domain. The previous
 * values stay on screen (marked "refreshing") until this finishes; if refreshes overlap,
 * only the newest one is applied.
 */
export async function refreshDashboard(dm: DomainManager): Promise<void> {
  const seq = ++refreshSeq;
  ui.setRefreshing(true);
  await refreshLocal(dm);
  void refreshLive(); // container state is known now; don't make the Overview wait for DNS and Cloudflare

  const containerStatus = new DockerService().getContainerStatus();
  const cf = new CloudflareService();
  const cloudflareConfigured = cf.isConfigured();
  const previous = ui.getState().dashboard;

  const [domainsResult, zonesResult, healthResult, usage] = await Promise.all([
    dm.listDomains(true).then(
      (value) => ({ ok: true as const, value }),
      (reason) => ({ ok: false as const, reason })
    ),
    cloudflareConfigured
      ? cf.listZones().then(
          (value) => ({ ok: true as const, value }),
          (reason) => ({ ok: false as const, reason })
        )
      : Promise.resolve({ ok: true as const, value: undefined }),
    loadHealth(containerStatus === 'running').catch(() => undefined),
    containerStatus === 'running' ? loadUsage() : Promise.resolve(undefined),
  ]);

  if (seq !== refreshSeq) return;

  let domains = previous.domains;
  if (domainsResult.ok) domains = domainsResult.value;
  else ui.toast('error', `Dashboard refresh failed: ${domainsResult.reason?.message ?? domainsResult.reason}`);

  // On a failed zone lookup keep the last known list and show the error beside it.
  const hidden = new Set(getAppConfig().hiddenZones);
  const zones = zonesResult.ok ? zonesResult.value?.filter((z) => !hidden.has(z.name.toLowerCase())) : previous.zones;
  const zonesError = zonesResult.ok ? undefined : String(zonesResult.reason?.message ?? zonesResult.reason);

  ui.setDashboard({
    ...ui.getState().dashboard,
    domains,
    containerStatus,
    cloudflareConfigured,
    health: healthResult ?? previous.health,
    zones,
    zonesError,
    usage: usage ?? (containerStatus === 'running' ? previous.usage : undefined),
    refreshedAt: new Date(),
  });
}

async function loadHealth(mailserverUp: boolean): Promise<Health> {
  const ops = new OpsService();
  const docker = new DockerService();
  const [bridge, tunnel, webmail, cert] = await Promise.all([
    docker.serviceState('inbound-bridge'),
    docker.serviceState('cloudflared'),
    process.env.WEBMAIL_HOSTNAME ? docker.serviceState('webmail') : Promise.resolve(undefined),
    mailserverUp ? ops.cert().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // WEBMAIL_HOSTNAME and POSTMARK_SERVER_TOKEN are special per-project env vars not in AppConfig.
  return { bridge, tunnel, webmail, relay: Boolean(process.env.POSTMARK_SERVER_TOKEN), certDays: cert?.daysLeft };
}

// ── Live feed for the Overview ───────────────────────────────────────────────

const LIVE_INTERVAL_MS = 5000;
/** `docker stats` takes about a second, so it runs on every third poll. */
const STATS_EVERY = 3;
let liveBusy = false;
let liveTick = 0;

/** State of the host's fail2ban-watcher service ("active", "inactive", …) or "n/a" without systemd. */
async function watcherState(): Promise<string> {
  try {
    const { stdout } = await execFileP('systemctl', ['is-active', 'fail2ban-watcher'], { timeout: 3000 });
    return stdout.trim() || 'n/a';
  } catch (err: any) {
    return String(err?.stdout ?? '').trim() || 'n/a';
  }
}

async function containerStartedAt(): Promise<Date | undefined> {
  const res = await new DockerService().runAsync(['inspect', '-f', '{{.State.StartedAt}}', 'mailserver']);
  const d = new Date(res.stdout.trim());
  return res.success && !Number.isNaN(d.getTime()) ? d : undefined;
}

async function containerStats(): Promise<ContainerStats | undefined> {
  const res = await new DockerService().runAsync([
    'stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}', 'mailserver',
  ]);
  return res.success ? parseContainerStats(res.stdout) : undefined;
}

/**
 * One poll of the Overview data. Overlapping ticks are skipped rather than queued, and a
 * failed poll keeps the last good data on screen with the error beside it.
 */
export async function refreshLive(): Promise<void> {
  if (liveBusy) return;
  const { dashboard } = ui.getState();
  if (dashboard.containerStatus !== 'running') {
    if (dashboard.live) ui.patchDashboard({ live: undefined });
    return;
  }
  liveBusy = true;
  try {
    const previous = dashboard.live;
    const withStats = liveTick++ % STATS_EVERY === 0 || !previous?.container;
    const [live, watcher, startedAt, container] = await Promise.all([
      new OpsService().live(),
      watcherState(),
      containerStartedAt(),
      withStats ? containerStats() : Promise.resolve(previous?.container),
    ]);
    ui.patchDashboard({ live: { ...live, watcher, startedAt, container: container ?? previous?.container } });
  } catch (err: any) {
    const previous = ui.getState().dashboard.live;
    if (previous) ui.patchDashboard({ live: { ...previous, error: String(err?.message ?? err) } });
  } finally {
    liveBusy = false;
  }
}

/** Polls every few seconds (paused while a prompt is open); returns a function that stops it. */
export function startLive(): () => void {
  void refreshLive();
  const timer = setInterval(() => {
    if (!ui.getState().prompt) void refreshLive();
  }, LIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}
