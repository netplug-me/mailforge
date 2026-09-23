import * as p from '@clack/prompts';
import readline from 'node:readline';
import { DomainManager } from '../services/domain-manager.js';
import { renderDashboardHeader } from './dashboard.js';
import {
  actionAddDomain,
  actionRemoveDomain,
  actionManageMailboxes,
  actionViewDkim,
  actionDnsOperations,
  actionDockerControl,
} from './actions.js';

// Hold action output on screen until the user is done reading it; the dashboard
// redraw at the top of the loop clears the screen.
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => { rl.close(); resolve(); });
    rl.question(`\n  Press Enter to return to the menu...`, () => { rl.close(); resolve(); });
  });
}

export async function startTui(): Promise<void> {
  const dm = new DomainManager();

  while (true) {
    const s = p.spinner();
    s.start('Fetching domain states & verifying live DNS...');
    const domains = await dm.listDomains(true);
    s.stop();

    renderDashboardHeader(domains);

    const action = await p.select({
      message: 'Select action:',
      options: [
        { value: 'refresh', label: '🔄 Refresh Status & DNS' },
        { value: 'add_domain', label: '➕ Add Domain / Sub-domain' },
        { value: 'remove_domain', label: '➖ Remove Domain' },
        { value: 'mailboxes', label: '👤 Manage Mailboxes & Aliases' },
        { value: 'dkim', label: '🔑 View / Generate DKIM Keys' },
        { value: 'dns', label: '🌐 Cloudflare DNS Operations' },
        { value: 'docker', label: '🐳 Docker Mailserver Container' },
        { value: 'exit', label: '🚪 Exit' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro('Goodbye!');
      break;
    }

    if (action === 'refresh') {
      continue;
    } else if (action === 'add_domain') {
      await actionAddDomain(dm);
    } else if (action === 'remove_domain') {
      await actionRemoveDomain(dm);
    } else if (action === 'mailboxes') {
      await actionManageMailboxes(dm);
    } else if (action === 'dkim') {
      await actionViewDkim(dm);
    } else if (action === 'dns') {
      await actionDnsOperations(dm);
    } else if (action === 'docker') {
      await actionDockerControl();
    }

    await waitForEnter();
  }
}
