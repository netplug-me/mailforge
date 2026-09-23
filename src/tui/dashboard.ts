import { DockerService } from '../services/docker.js';
import { CloudflareService } from '../services/cloudflare.js';
import { DomainManager } from '../services/domain-manager.js';
import { ui } from './ui.js';

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

  const [domainsResult, zonesResult] = await Promise.allSettled([
    dm.listDomains(true),
    cloudflareConfigured ? cf.listZones() : Promise.resolve(undefined),
  ]);

  let domains = previous.domains;
  if (domainsResult.status === 'fulfilled') domains = domainsResult.value;
  else ui.error(`Dashboard refresh failed: ${domainsResult.reason?.message ?? domainsResult.reason}`);

  // On a failed zone lookup keep the last known list and show the error in the zones box.
  const zones = zonesResult.status === 'fulfilled' ? zonesResult.value : previous.zones;
  const zonesError =
    zonesResult.status === 'rejected' ? String(zonesResult.reason?.message ?? zonesResult.reason) : undefined;

  if (seq === refreshSeq) {
    ui.setDashboard({ domains, containerStatus, cloudflareConfigured, zones, zonesError, refreshedAt: new Date() });
  }
}
