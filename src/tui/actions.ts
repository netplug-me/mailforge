import * as p from '@clack/prompts';
import chalk from 'chalk';
import { getAppConfig } from '../config.js';
import { DomainManager } from '../services/domain-manager.js';
import { DmsService } from '../services/dms.js';
import { DockerService } from '../services/docker.js';
import { DkimService } from '../services/dkim.js';
import { DnsCheckerService } from '../services/dns.js';
import { CloudflareService } from '../services/cloudflare.js';
import { isValidDomain, isValidEmail, normalizeDomain } from '../utils/validator.js';

export async function actionAddDomain(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const cf = new CloudflareService();

  const domain = await p.text({
    message: 'Enter domain or sub-domain to add (e.g. shop.example.com):',
    placeholder: 'sub.example.com',
    validate: (val) => {
      if (!val || !val.trim()) return 'Domain cannot be empty';
      const d = val.trim().toLowerCase();
      if (!isValidDomain(d)) return 'Invalid domain format';
      if (d === config.primaryDomain) return 'Cannot add the primary domain';
      if (dm.getAllDomains().includes(d)) return 'Domain is already registered';
    },
  });

  if (p.isCancel(domain)) return;

  const usersInput = await p.text({
    message: 'Initial email user(s) to create (comma separated, e.g. "sales, info") [optional]:',
    placeholder: 'sales, support',
  });
  if (p.isCancel(usersInput)) return;

  const users = usersInput
    ? usersInput
        .split(',')
        .map((u) => u.trim())
        .filter((u) => u.length > 0)
    : [];

  let password = '';
  let quota = '';
  let forward = '';

  if (users.length > 0) {
    const isForward = await p.confirm({
      message: 'Forward these users to an external email address (alias) instead of creating mailboxes?',
      initialValue: false,
    });
    if (p.isCancel(isForward)) return;

    if (isForward) {
      const fwd = await p.text({
        message: 'Destination email address for forwarding:',
        placeholder: 'you@gmail.com',
        validate: (val) => (!isValidEmail(val) ? 'Invalid email format' : undefined),
      });
      if (p.isCancel(fwd)) return;
      forward = fwd;
    } else {
      const pwd = await p.text({
        message: 'Initial password for user accounts (leave empty for DMS auto-prompt):',
        placeholder: 'SecretPassword123!',
      });
      if (p.isCancel(pwd)) return;
      password = pwd;

      const q = await p.text({
        message: 'Mailbox quota (e.g. 500M, 2G, leave empty for default):',
        placeholder: '1G',
      });
      if (p.isCancel(q)) return;
      quota = q;
    }
  }

  let syncDns = false;
  if (cf.isConfigured()) {
    const sync = await p.confirm({
      message: 'Automatically publish MX, SPF, DKIM, and DMARC records to Cloudflare?',
      initialValue: true,
    });
    if (p.isCancel(sync)) return;
    syncDns = sync;
  }

  const s = p.spinner();
  s.start(`Adding domain ${domain}...`);

  try {
    const res = await dm.addDomain({
      domain,
      users,
      password: password || undefined,
      quota: quota || undefined,
      forward: forward || undefined,
      syncDns,
    });

    s.stop(`Domain ${domain} successfully added!`);

    let noteText = `Domain registered in POSTFIX_VIRTUAL_DOMAINS.\nDKIM key generated: ${res.dkimGenerated ? 'Yes' : 'No'}`;
    if (res.dkimValue) {
      noteText += `\nDKIM Record Value:\n${res.dkimValue}`;
    }
    if (res.accountsAdded.length > 0) {
      noteText += `\nAccounts: ${res.accountsAdded.join(', ')}`;
    }
    if (res.dnsSyncResult) {
      noteText += `\nCloudflare Zone: ${res.dnsSyncResult.zone.name} (Synchronized ${res.dnsSyncResult.results.length} records)`;
    }

    p.note(noteText, 'Domain Provisioned');
  } catch (err: any) {
    s.stop('Failed to add domain');
    p.log.error(err.message);
  }
}

export async function actionRemoveDomain(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const cf = new CloudflareService();

  const virtualDomains = dm.getAllDomains().filter((d) => d !== config.primaryDomain);
  if (virtualDomains.length === 0) {
    p.log.warn('No virtual domains found to remove. (Primary domain cannot be removed)');
    return;
  }

  const domain = await p.select({
    message: 'Select domain to remove:',
    options: virtualDomains.map((d) => ({ value: d, label: d })),
  });
  if (p.isCancel(domain)) return;

  const deleteData = await p.confirm({
    message: `Permanently delete stored mail data for ${domain}?`,
    initialValue: false,
  });
  if (p.isCancel(deleteData)) return;

  let deleteDns = false;
  if (cf.isConfigured()) {
    const dnsConfirm = await p.confirm({
      message: `Delete email DNS records (MX, SPF, DKIM, DMARC) for ${domain} from Cloudflare?`,
      initialValue: true,
    });
    if (p.isCancel(dnsConfirm)) return;
    deleteDns = dnsConfirm;
  }

  const confirmed = await p.confirm({
    message: chalk.red(`Are you sure you want to remove ${domain}? This will stop accepting email for this domain.`),
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) return;

  const s = p.spinner();
  s.start(`Removing domain ${domain}...`);

  try {
    const res = await dm.removeDomain({
      domain,
      deleteData,
      deleteDns,
    });

    s.stop(`Domain ${domain} removed.`);
    let summary = `Removed from configuration.\nAccounts purged: ${res.accountsDeleted.length}`;
    if (res.dataDeleted) summary += '\nMail data: DELETED';
    if (res.dnsDeletedResult) summary += `\nCloudflare records deleted: ${res.dnsDeletedResult.deletedCount}`;

    p.note(summary, 'Domain Removal Complete');
  } catch (err: any) {
    s.stop('Failed to remove domain');
    p.log.error(err.message);
  }
}

export async function actionManageMailboxes(dm: DomainManager): Promise<void> {
  const dms = new DmsService();
  const allDomains = dm.getAllDomains();

  const domain = await p.select({
    message: 'Select domain to manage mailboxes/aliases for:',
    options: allDomains.map((d) => ({ value: d, label: d })),
  });
  if (p.isCancel(domain)) return;

  while (true) {
    const accounts = dms.listAccounts().filter((a) => a.domain.toLowerCase() === domain.toLowerCase());
    const aliases = dms.listAliases().filter((a) => a.source.toLowerCase().endsWith(`@${domain.toLowerCase()}`));

    console.log();
    console.log(chalk.bold.cyan(`Mailboxes & Aliases for ${domain}:`));
    if (accounts.length === 0 && aliases.length === 0) {
      console.log(chalk.dim('  (No mailboxes or aliases configured yet)'));
    } else {
      for (const a of accounts) {
        console.log(`  👤 ${chalk.bold(a.email)}`);
      }
      for (const al of aliases) {
        console.log(`  ↪ ${chalk.bold(al.source)} -> ${chalk.dim(al.destination)}`);
      }
    }
    console.log();

    const action = await p.select({
      message: 'Choose an action:',
      options: [
        { value: 'add_account', label: '➕ Add Email Account' },
        { value: 'del_account', label: '➖ Delete Email Account' },
        { value: 'set_quota', label: '💾 Set Mailbox Quota' },
        { value: 'add_alias', label: '↪ Add Forwarder / Alias' },
        { value: 'del_alias', label: '❌ Delete Forwarder / Alias' },
        { value: 'back', label: '← Back to Main Menu' },
      ],
    });

    if (p.isCancel(action) || action === 'back') break;

    if (action === 'add_account') {
      const username = await p.text({
        message: `Username for new account (@${domain}):`,
        placeholder: 'john',
      });
      if (p.isCancel(username)) continue;

      const password = await p.text({
        message: 'Password for new account:',
        placeholder: 'SecretPassword123!',
      });
      if (p.isCancel(password)) continue;

      const email = `${username.trim()}@${domain}`;
      const s = p.spinner();
      s.start(`Adding account ${email}...`);
      const res = dms.addAccount(email, password.trim() || undefined);
      if (res.success) {
        s.stop(`Account ${email} created!`);
      } else {
        s.stop('Failed to create account');
        p.log.error(res.stderr || res.stdout);
      }
    } else if (action === 'del_account') {
      if (accounts.length === 0) {
        p.log.warn('No accounts exist to delete.');
        continue;
      }
      const target = await p.select({
        message: 'Select account to delete:',
        options: accounts.map((a) => ({ value: a.email, label: a.email })),
      });
      if (p.isCancel(target)) continue;

      const s = p.spinner();
      s.start(`Deleting ${target}...`);
      const res = dms.delAccount(target);
      if (res.success) {
        s.stop(`Account ${target} deleted.`);
      } else {
        s.stop('Failed to delete account');
        p.log.error(res.stderr || res.stdout);
      }
    } else if (action === 'set_quota') {
      if (accounts.length === 0) {
        p.log.warn('No accounts exist.');
        continue;
      }
      const target = await p.select({
        message: 'Select account:',
        options: accounts.map((a) => ({ value: a.email, label: a.email })),
      });
      if (p.isCancel(target)) continue;

      const quota = await p.text({
        message: 'Enter quota size (e.g. 500M, 2G):',
        placeholder: '1G',
      });
      if (p.isCancel(quota)) continue;

      const s = p.spinner();
      s.start(`Setting quota for ${target}...`);
      const res = dms.setQuota(target, quota.trim());
      if (res.success) {
        s.stop(`Quota set to ${quota} for ${target}!`);
      } else {
        s.stop('Failed to set quota');
        p.log.error(res.stderr || res.stdout);
      }
    } else if (action === 'add_alias') {
      const srcUser = await p.text({
        message: `Alias name (@${domain}):`,
        placeholder: 'support',
      });
      if (p.isCancel(srcUser)) continue;

      const dest = await p.text({
        message: 'Destination address:',
        placeholder: 'user@external.com',
      });
      if (p.isCancel(dest)) continue;

      const srcEmail = `${srcUser.trim()}@${domain}`;
      const s = p.spinner();
      s.start(`Adding alias ${srcEmail} -> ${dest}...`);
      const res = dms.addAlias(srcEmail, dest.trim());
      if (res.success) {
        s.stop(`Alias created!`);
      } else {
        s.stop('Failed to create alias');
        p.log.error(res.stderr || res.stdout);
      }
    } else if (action === 'del_alias') {
      if (aliases.length === 0) {
        p.log.warn('No aliases exist.');
        continue;
      }
      const target = await p.select({
        message: 'Select alias to delete:',
        options: aliases.map((al) => ({ value: al, label: `${al.source} -> ${al.destination}` })),
      });
      if (p.isCancel(target)) continue;

      const s = p.spinner();
      s.start(`Deleting alias ${target.source}...`);
      const res = dms.delAlias(target.source, target.destination);
      if (res.success) {
        s.stop(`Alias deleted!`);
      } else {
        s.stop('Failed to delete alias');
        p.log.error(res.stderr || res.stdout);
      }
    }
  }
}

export async function actionViewDkim(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const dkim = new DkimService();
  const dms = new DmsService();
  const cf = new CloudflareService();
  const allDomains = dm.getAllDomains();

  const domain = await p.select({
    message: 'Select domain to inspect DKIM keys:',
    options: allDomains.map((d) => ({ value: d, label: d })),
  });
  if (p.isCancel(domain)) return;

  const info = dkim.getDkimInfo(domain, config.dkimSelector);

  let details = `Domain:   ${domain}\nSelector: ${config.dkimSelector}\nStatus:   ${info.exists ? '● Found on disk' : '○ Not generated'}`;
  if (info.filePath) {
    details += `\nPath:     ${info.filePath}`;
  }
  if (info.dnsValue) {
    details += `\n\nDNS Host:  ${config.dkimSelector}._domainkey.${domain}\nType:      TXT\nValue:\n${info.dnsValue}`;
  }

  p.note(details, `DKIM Information: ${domain}`);

  const options = [{ value: 'back', label: '← Back' }];
  if (!info.exists) {
    options.unshift({ value: 'generate', label: '🔑 Generate DKIM Key' });
  } else {
    options.unshift({ value: 'regenerate', label: '🔄 Regenerate DKIM Key' });
    if (cf.isConfigured()) {
      options.unshift({ value: 'sync_cf', label: '🌐 Publish DKIM to Cloudflare' });
    }
  }

  const choice = await p.select({
    message: 'DKIM Actions:',
    options,
  });

  if (choice === 'generate' || choice === 'regenerate') {
    const s = p.spinner();
    s.start(`Generating DKIM key for ${domain}...`);
    const res = dms.generateDkim(domain, config.dkimSelector);
    if (res.success) {
      s.stop('DKIM key generated successfully!');
    } else {
      s.stop('Failed to generate DKIM');
      p.log.error(res.stderr || res.stdout);
    }
  } else if (choice === 'sync_cf') {
    const s = p.spinner();
    s.start('Publishing DKIM record to Cloudflare...');
    try {
      await dm.syncDns(domain);
      s.stop('DKIM published to Cloudflare!');
    } catch (err: any) {
      s.stop('Failed to publish DKIM');
      p.log.error(err.message);
    }
  }
}

export async function actionDnsOperations(dm: DomainManager): Promise<void> {
  const config = getAppConfig();
  const checker = new DnsCheckerService();
  const cf = new CloudflareService();
  const allDomains = dm.getAllDomains();

  const domain = await p.select({
    message: 'Select domain for DNS operations:',
    options: allDomains.map((d) => ({ value: d, label: d })),
  });
  if (p.isCancel(domain)) return;

  const s = p.spinner();
  s.start(`Querying live DNS for ${domain}...`);
  const status = await checker.checkAll(domain, config.mxHost, config.dkimSelector);
  s.stop(`Live DNS query complete for ${domain}`);

  let report = '';
  const addItem = (title: string, item: any) => {
    report += `\n[${item.status.toUpperCase()}] ${title}`;
    if (item.records && item.records.length > 0) {
      report += `\n  Found: ${item.records.join(', ')}`;
    } else {
      report += `\n  Found: <none>`;
    }
    if (item.expected) {
      report += `\n  Expected: ${item.expected}`;
    }
    report += '\n';
  };

  addItem('MX Record', status.mx);
  addItem('SPF TXT Record', status.spf);
  addItem(`DKIM TXT Record (${config.dkimSelector}._domainkey.${domain})`, status.dkim);
  addItem(`DMARC TXT Record (_dmarc.${domain})`, status.dmarc);

  p.note(report.trim(), `DNS Health Status: ${domain}`);

  const options = [{ value: 'back', label: '← Back' }];
  if (cf.isConfigured()) {
    options.unshift({ value: 'sync', label: '🌐 Sync All 4 Records to Cloudflare' });
  }

  const choice = await p.select({
    message: 'DNS Actions:',
    options,
  });

  if (choice === 'sync') {
    const syncSpinner = p.spinner();
    syncSpinner.start(`Synchronizing DNS records for ${domain} to Cloudflare...`);
    try {
      const res = await dm.syncDns(domain);
      syncSpinner.stop(`Cloudflare synchronization complete!`);
      for (const item of res.results) {
        if (item.error) {
          p.log.error(`${item.recordType} ${item.name}: ${item.error}`);
        } else {
          p.log.success(`${item.recordType} ${item.name}: ${item.action}`);
        }
      }
    } catch (err: any) {
      syncSpinner.stop('Sync failed');
      p.log.error(err.message);
    }
  }
}

export async function actionDockerControl(): Promise<void> {
  const docker = new DockerService();

  const choice = await p.select({
    message: 'Docker Mailserver Container Actions:',
    options: [
      { value: 'status', label: '📊 Check Container Status' },
      { value: 'up', label: '🚀 Start Container (compose up -d)' },
      { value: 'recreate', label: '🔄 Force Recreate Container' },
      { value: 'restart', label: '♻️ Restart Container' },
      { value: 'down', label: '🛑 Stop Container (compose down)' },
      { value: 'logs', label: '📜 View Recent Logs' },
      { value: 'back', label: '← Back to Main Menu' },
    ],
  });

  if (p.isCancel(choice) || choice === 'back') return;

  if (choice === 'status') {
    const status = docker.getContainerStatus();
    p.log.info(`Container status: ${status.toUpperCase()}`);
  } else if (choice === 'up') {
    const s = p.spinner();
    s.start('Starting container...');
    const res = docker.composeUp();
    s.stop(res.success ? 'Container started.' : 'Failed to start container.');
    if (!res.success) p.log.error(res.stderr || res.stdout);
  } else if (choice === 'recreate') {
    const s = p.spinner();
    s.start('Recreating container...');
    const res = docker.composeUp(true);
    s.stop(res.success ? 'Container recreated and running.' : 'Failed to recreate.');
    if (!res.success) p.log.error(res.stderr || res.stdout);
  } else if (choice === 'restart') {
    const s = p.spinner();
    s.start('Restarting container...');
    const res = docker.composeRestart();
    s.stop(res.success ? 'Container restarted.' : 'Failed to restart.');
    if (!res.success) p.log.error(res.stderr || res.stdout);
  } else if (choice === 'down') {
    const s = p.spinner();
    s.start('Stopping container...');
    const res = docker.composeDown();
    s.stop(res.success ? 'Container stopped.' : 'Failed to stop.');
    if (!res.success) p.log.error(res.stderr || res.stdout);
  } else if (choice === 'logs') {
    const res = docker.getLogs(40);
    console.log();
    console.log(chalk.dim('--- Docker Mailserver Logs (last 40 lines) ---'));
    console.log(res.stdout || res.stderr || chalk.dim('No logs available.'));
    console.log(chalk.dim('---------------------------------------------'));
  }
}
