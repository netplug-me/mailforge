import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { getAppConfig } from '../config.js';
import { DmsService } from '../services/dms.js';
import { DomainManager } from '../services/domain-manager.js';
import { DockerService } from '../services/docker.js';
import { DkimService } from '../services/dkim.js';
import { DnsCheckerService } from '../services/dns.js';
import { CloudflareService } from '../services/cloudflare.js';
import { logger } from '../utils/logger.js';
import { renderDomainTable } from '../utils/table.js';
import { startTui } from '../tui/app.js';

export function registerCommands(program: Command): void {
  const config = getAppConfig();

  // 1. Init / Scaffold
  program
    .command('init [dest]')
    .description('Scaffold a Docker Mailserver project directory')
    .option('-d, --domain <domain>', 'Primary domain', config.primaryDomain)
    .option('-m, --mx <host>', 'MX Hostname', config.mxHost)
    .option('-f, --force', 'Overwrite existing files', false)
    .action(async (dest, opts) => {
      const targetDir = dest ? path.resolve(dest) : config.projectDir;
      logger.header('DMS Project Scaffolding', `Target: ${targetDir}`);

      const dms = new DmsService(targetDir);
      const res = dms.scaffold({
        primaryDomain: opts.domain,
        mxHost: opts.mx,
        projectDir: targetDir,
        overwrite: opts.force,
      });

      if (res.created.length > 0) {
        logger.success('Created files and directories:');
        for (const item of res.created) {
          console.log(`  + ${item}`);
        }
      }
      if (res.skipped.length > 0) {
        logger.warn('Skipped existing files (use --force to overwrite):');
        for (const item of res.skipped) {
          console.log(`  - ${item}`);
        }
      }

      for (const w of res.warnings) {
        logger.warn(w);
      }

      console.log();
      logger.info('Next steps:');
      console.log(`  1. cd ${targetDir}`);
      console.log('  2. Edit .env (set CF_API_TOKEN if using Cloudflare)');
      console.log('  3. Run: mailforge list (or mailforge tui)');
    });

  // 2. List domains
  program
    .command('list')
    .alias('ls')
    .description('List all primary and virtual domains with mailbox & DNS health')
    .option('--no-dns', 'Skip live DNS resolution checks')
    .action(async (opts) => {
      const dm = new DomainManager();
      logger.header('DMS Mail Domain Console', `Primary: ${config.primaryDomain} | MX: ${config.mxHost}`);

      const checkDns = opts.dns !== false;
      if (checkDns) {
        console.log(chalk.dim('Checking live DNS records...'));
      }

      const domains = await dm.listDomains(checkDns);
      console.log(renderDomainTable(domains));
      console.log(chalk.dim('● ok / published   ○ missing   ▲ mismatch'));
    });

  // 3. Add domain
  program
    .command('add <domain> [users...]')
    .description('Add a virtual (sub-)domain to Docker Mailserver')
    .option('-q, --quota <quota>', 'Mailbox storage quota (e.g. 500M, 2G)')
    .option('-p, --password <password>', 'Initial password for added users')
    .option('-f, --forward <destination>', 'Forward email for user(s) to destination alias')
    .option('--dns', 'Automatically create / sync DNS records in Cloudflare', false)
    .action(async (domain, users, opts) => {
      logger.header(`Adding Domain: ${domain}`);
      const dm = new DomainManager();

      try {
        const res = await dm.addDomain({
          domain,
          users,
          password: opts.password,
          quota: opts.quota,
          forward: opts.forward,
          syncDns: opts.dns,
        });

        logger.success(`Domain ${domain} added to POSTFIX_VIRTUAL_DOMAINS`);
        if (res.dkimGenerated) {
          logger.success(`DKIM key generated (${config.dkimSelector})`);
          if (res.dkimValue) {
            console.log(chalk.dim(`Record: ${config.dkimSelector}._domainkey.${domain}`));
            console.log(chalk.cyan(res.dkimValue));
          }
        }

        if (res.accountsAdded.length > 0) {
          logger.success(`Accounts created: ${res.accountsAdded.join(', ')}`);
        }
        if (res.aliasesAdded.length > 0) {
          logger.success(`Aliases created: ${res.aliasesAdded.join(', ')}`);
        }
        for (const e of res.errors) {
          logger.warn(e);
        }
        if (res.errors.length > 0) process.exitCode = 1;

        if (opts.dns) {
          if (res.dnsSyncResult) {
            logger.success(`Cloudflare DNS synchronized to zone: ${res.dnsSyncResult.zone.name}`);
            for (const r of res.dnsSyncResult.results) {
              const statusColor = r.error ? chalk.red(`failed: ${r.error}`) : chalk.green(r.action);
              console.log(`  - [${r.recordType}] ${r.name} -> ${statusColor}`);
            }
          } else {
            logger.warn('Cloudflare DNS sync requested but CF_API_TOKEN is not configured.');
          }
        }

        console.log();
        console.log(chalk.bold('Verify:'));
        console.log(`  dig +short MX ${domain}`);
        console.log(`  dig +short TXT ${config.dkimSelector}._domainkey.${domain}`);
        console.log(`  dig +short TXT _dmarc.${domain}`);
      } catch (err: any) {
        logger.error(err.message);
        process.exitCode = 1;
      }
    });

  // 4. Remove domain
  program
    .command('remove <domain>')
    .alias('rm')
    .description('Remove a virtual domain from Docker Mailserver')
    .option('--users [users...]', 'Specific users to remove (or omit to remove all for domain)')
    .option('--data', 'Permanently delete mail data directory for domain', false)
    .option('--dns', 'Delete mail DNS records from Cloudflare', false)
    .option('-y, --yes', 'Skip confirmation prompt', false)
    .action(async (domain, opts) => {
      logger.header(`Removing Domain: ${domain}`);
      const dm = new DomainManager();

      try {
        const res = await dm.removeDomain({
          domain,
          users: opts.users,
          deleteData: opts.data,
          deleteDns: opts.dns,
        });

        logger.success(`Domain ${domain} removed from configuration.`);
        for (const e of res.errors) {
          logger.warn(e);
        }
        if (res.errors.length > 0) process.exitCode = 1;
        if (res.accountsDeleted.length > 0) {
          logger.info(`Deleted accounts: ${res.accountsDeleted.join(', ')}`);
        }
        if (res.dkimRemoved) {
          logger.info('DKIM keys removed.');
        }
        if (res.dataDeleted) {
          logger.warn(`Mail data directory deleted for ${domain}.`);
        }
        if (res.dnsDeletedResult) {
          logger.info(`Deleted ${res.dnsDeletedResult.deletedCount} Cloudflare DNS record(s).`);
        }
      } catch (err: any) {
        logger.error(err.message);
        process.exitCode = 1;
      }
    });

  // 5. DKIM info & generator
  program
    .command('dkim <domain>')
    .description('Inspect or generate DKIM keys for a domain')
    .option('-g, --generate', 'Generate new DKIM keys if missing', false)
    .action(async (domain, opts) => {
      const dkimService = new DkimService();
      const dms = new DmsService();

      if (opts.generate) {
        logger.info(`Generating DKIM keys for ${domain}...`);
        const res = dms.generateDkim(domain, config.dkimSelector);
        if (res.success) {
          logger.success('DKIM key generation completed.');
        } else {
          logger.error(`DKIM generation failed: ${res.stderr || res.stdout}`);
        }
      }

      const info = dkimService.getDkimInfo(domain, config.dkimSelector);
      logger.header(`DKIM Information: ${domain}`);
      console.log(`Status:   ${info.exists ? chalk.green('● Found') : chalk.red('○ Missing')}`);
      console.log(`Selector: ${info.selector}`);
      if (info.filePath) {
        console.log(`Key File: ${info.filePath}`);
      }
      if (info.dnsValue) {
        console.log();
        console.log(chalk.bold('DNS Record Details:'));
        console.log(`  Host/Name: ${info.selector}._domainkey.${domain}`);
        console.log(`  Type:      TXT`);
        console.log(`  Value:     ${chalk.cyan(info.dnsValue)}`);
      }
    });

  // 6. DNS check & sync
  const dnsCmd = program.command('dns').description('Check or sync DNS records');

  dnsCmd
    .command('check <domain>')
    .description('Perform live DNS resolution checks for MX, SPF, DKIM, DMARC')
    .action(async (domain) => {
      logger.header(`Live DNS Check: ${domain}`);
      const checker = new DnsCheckerService();
      const res = await checker.checkAll(domain, config.mxHost, config.dkimSelector);

      const printItem = (name: string, item: any) => {
        const badge =
          item.status === 'valid'
            ? chalk.green('● VALID')
            : item.status === 'invalid'
            ? chalk.yellow('▲ MISMATCH')
            : chalk.red('○ MISSING');
        console.log(`${badge} ${chalk.bold(name)}`);
        if (item.detail) console.log(`  ${chalk.dim(item.detail)}`);
        if (item.records && item.records.length > 0) {
          for (const r of item.records) {
            console.log(`  Found: ${chalk.cyan(r)}`);
          }
        }
        if (item.expected) {
          console.log(`  Expected: ${chalk.dim(item.expected)}`);
        }
        console.log();
      };

      printItem('MX Record', res.mx);
      printItem('SPF Record (TXT)', res.spf);
      printItem(`DKIM Record (${config.dkimSelector}._domainkey.${domain})`, res.dkim);
      printItem(`DMARC Record (_dmarc.${domain})`, res.dmarc);
    });

  dnsCmd
    .command('sync <domain>')
    .description('Synchronize MX, SPF, DKIM, DMARC records to Cloudflare')
    .action(async (domain) => {
      logger.header(`Cloudflare DNS Sync: ${domain}`);
      const dm = new DomainManager();
      try {
        const res = await dm.syncDns(domain);
        logger.success(`Synced to Cloudflare Zone: ${res.zone.name} (${res.zone.id})`);
        for (const item of res.results) {
          if (item.error) {
            logger.error(`${item.recordType} ${item.name}: ${item.error}`);
          } else {
            logger.success(`${item.recordType} ${item.name}: ${item.action}`);
          }
        }
      } catch (err: any) {
        logger.error(err.message);
        process.exitCode = 1;
      }
    });

  // 7. Compose / Docker control
  const dockerCmd = program.command('docker').alias('compose').description('Manage Docker Mailserver container');

  dockerCmd
    .command('status')
    .description('Check mailserver container status')
    .action(() => {
      const docker = new DockerService();
      const status = docker.getContainerStatus();
      const color = status === 'running' ? chalk.green : chalk.red;
      console.log(`Status: ${color(status.toUpperCase())}`);
    });

  dockerCmd
    .command('up')
    .description('Start Docker Mailserver')
    .option('-r, --recreate', 'Force recreate container', false)
    .action((opts) => {
      const docker = new DockerService();
      logger.info('Starting container...');
      const res = docker.composeUp(opts.recreate);
      if (res.success) {
        logger.success('Mailserver started.');
      } else {
        logger.error(res.stderr || res.stdout);
      }
    });

  dockerCmd
    .command('down')
    .description('Stop Docker Mailserver')
    .action(() => {
      const docker = new DockerService();
      logger.info('Stopping container...');
      const res = docker.composeDown();
      if (res.success) {
        logger.success('Mailserver stopped.');
      } else {
        logger.error(res.stderr || res.stdout);
      }
    });

  dockerCmd
    .command('logs')
    .description('Show container logs')
    .option('-n, --lines <number>', 'Lines of logs to show', '50')
    .action((opts) => {
      const docker = new DockerService();
      const res = docker.getLogs(parseInt(opts.lines, 10));
      console.log(res.stdout || res.stderr);
    });

  // 8. TUI command
  program
    .command('tui')
    .description('Launch the interactive Terminal User Interface (mailforge)')
    .action(async () => {
      await startTui();
    });
}
