import { getAppConfig } from '../config.js';
import { DockerService } from '../services/docker.js';
import { CloudflareService } from '../services/cloudflare.js';
import { DmsService } from '../services/dms.js';
import { DomainManager } from '../services/domain-manager.js';
import { OpsService, QuotaRow } from '../services/ops.js';
import { DomainInfo } from '../types.js';
import { Health, ui } from './ui.js';

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
