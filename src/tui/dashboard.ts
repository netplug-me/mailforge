import chalk from 'chalk';
import { getAppConfig } from '../config.js';
import { DockerService } from '../services/docker.js';
import { CloudflareService } from '../services/cloudflare.js';
import { DomainInfo } from '../types.js';
import { renderDomainTable } from '../utils/table.js';

export function renderDashboardHeader(domains: DomainInfo[]): void {
  const config = getAppConfig();
  const docker = new DockerService();
  const cf = new CloudflareService();

  const containerStatus = docker.getContainerStatus();
  const statusBadge =
    containerStatus === 'running'
      ? chalk.bold.green('RUNNING')
      : containerStatus === 'exited'
      ? chalk.bold.yellow('EXITED')
      : chalk.bold.red('STOPPED');

  const cfBadge = cf.isConfigured() ? chalk.green('CONFIGURED') : chalk.dim('NOT SET (CF_API_TOKEN)');

  // Clear the visible screen only (not console.clear(), which also wipes scrollback in most
  // terminals), so earlier action output can still be scrolled back to.
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(chalk.bold.cyan('╔════════════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║') + '             ' + chalk.bold.white('DOCKER MAILSERVER & CLOUDFLARE MANAGER') + '              ' + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('╠════════════════════════════════════════════════════════════════════════╣'));
  console.log(
    chalk.bold.cyan('║') +
      `  Primary Domain: ${chalk.bold.white(config.primaryDomain.padEnd(20))} Container: ${statusBadge.padEnd(24)}` +
      chalk.bold.cyan('║')
  );
  console.log(
    chalk.bold.cyan('║') +
      `  MX Host:        ${chalk.bold.white(config.mxHost.padEnd(20))} Cloudflare: ${cfBadge.padEnd(23)}` +
      chalk.bold.cyan('║')
  );
  console.log(
    chalk.bold.cyan('║') +
      `  DKIM Selector:  ${chalk.bold.white(config.dkimSelector.padEnd(20))} Registered Domains: ${chalk.bold.white(domains.length.toString().padEnd(14))}` +
      chalk.bold.cyan('║')
  );
  console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════════════════════════╝'));
  console.log();
  console.log(renderDomainTable(domains));
  console.log(chalk.dim('Legend: ● ok/valid   ○ missing   ▲ mismatch   ? unknown'));
  console.log();
}
