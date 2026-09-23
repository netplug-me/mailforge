import Table from 'cli-table3';
import chalk from 'chalk';
import { DomainInfo } from '../types.js';

export function renderDomainTable(domains: DomainInfo[]): string {
  const table = new Table({
    head: [
      chalk.bold('DOMAIN'),
      chalk.bold('TYPE'),
      chalk.bold('MBX'),
      chalk.bold('DKIM'),
      chalk.bold('MX'),
      chalk.bold('SPF'),
      chalk.bold('DKIM-DNS'),
      chalk.bold('DMARC'),
    ],
    style: {
      head: ['cyan'],
      border: ['dim'],
    },
  });

  for (const d of domains) {
    const typeLabel = d.isPrimary ? chalk.blue('primary') : chalk.dim('virtual');
    const mbxCount = d.mailboxCount.toString();
    const dkimBadge = d.dkimExists ? chalk.green('● yes') : chalk.red('○ no');

    const formatDns = (status: 'valid' | 'missing' | 'invalid' | 'unknown') => {
      switch (status) {
        case 'valid':
          return chalk.green('● ok');
        case 'invalid':
          return chalk.yellow('▲ err');
        case 'missing':
          return chalk.red('○ miss');
        default:
          return chalk.dim('?');
      }
    };

    table.push([
      d.domain,
      typeLabel,
      mbxCount,
      dkimBadge,
      formatDns(d.dnsStatus.mx.status),
      formatDns(d.dnsStatus.spf.status),
      formatDns(d.dnsStatus.dkim.status),
      formatDns(d.dnsStatus.dmarc.status),
    ]);
  }

  return table.toString();
}
