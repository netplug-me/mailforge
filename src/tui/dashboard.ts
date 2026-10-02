import { getAppConfig } from '../config.js';
import { DockerService } from '../services/docker.js';
import { CloudflareService } from '../services/cloudflare.js';
import { DomainManager } from '../services/domain-manager.js';
import { OpsService } from '../services/ops.js';
import { Health, ui } from './ui.js';

let refreshSeq = 0;

/**
 * Re-reads container status, Cloudflare config and live DNS for every domain.
 * The previous dashboard stays on screen (marked "refreshing") until this finishes;
 * if refreshes overlap, only the newest one is applied.
 */
export async function refreshDashboard(dm: DomainManager): Promise<void> {
  const seq = ++refreshSeq;
  ui.setRefreshing(true);
  // Let the "refreshing" marker paint before the synchronous docker inspect.
  await new Promise((r) => setTimeout(r, 30));

  const previous = ui.getState().dashboard;
  const containerStatus = new DockerService().getContainerStatus();
  const cf = new CloudflareService();
  const cloudflareConfigured = cf.isConfigured();

  const [domainsResult, zonesResult, healthResult] = await Promise.allSettled([
    dm.listDomains(true),
    cloudflareConfigured ? cf.listZones() : Promise.resolve(undefined),
    loadHealth(containerStatus === 'running'),
  ]);

  let domains = previous.domains;
  if (domainsResult.status === 'fulfilled') domains = domainsResult.value;
  else ui.error(`Dashboard refresh failed: ${domainsResult.reason?.message ?? domainsResult.reason}`);

  // On a failed zone lookup keep the last known list and show the error in the zones box.
  const hidden = new Set(getAppConfig().hiddenZones);
  const zones =
    zonesResult.status === 'fulfilled'
      ? zonesResult.value?.filter((z) => !hidden.has(z.name.toLowerCase()))
      : previous.zones;
  const zonesError =
    zonesResult.status === 'rejected' ? String(zonesResult.reason?.message ?? zonesResult.reason) : undefined;

  if (seq === refreshSeq) {
    const health = healthResult.status === 'fulfilled' ? healthResult.value : previous.health;
    ui.setDashboard({ domains, containerStatus, cloudflareConfigured, health, zones, zonesError, refreshedAt: new Date() });
  }
}

async function loadHealth(mailserverUp: boolean): Promise<Health> {
  const ops = new OpsService();
  const docker = new DockerService();
  const [bridge, tunnel, cert] = await Promise.all([
    docker.serviceState('inbound-bridge'),
    docker.serviceState('cloudflared'),
    mailserverUp ? ops.cert().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { bridge, tunnel, relay: Boolean(process.env.POSTMARK_SERVER_TOKEN), certDays: cert?.daysLeft };
}
