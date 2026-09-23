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

  const containerStatus = new DockerService().getContainerStatus();
  const cloudflareConfigured = new CloudflareService().isConfigured();
  let domains = ui.getState().dashboard.domains;
  try {
    domains = await dm.listDomains(true);
  } catch (err: any) {
    ui.error(`Dashboard refresh failed: ${err.message}`);
  }

  if (seq === refreshSeq) {
    ui.setDashboard({ domains, containerStatus, cloudflareConfigured, refreshedAt: new Date() });
  }
}
