import React from 'react';
import { render } from 'ink';
import { DomainManager } from '../services/domain-manager.js';
import { refreshDashboard } from './dashboard.js';
import { App } from './view.js';
import { isCancel, ui } from './ui.js';
import {
  actionAddDomain,
  actionRemoveDomain,
  actionManageMailboxes,
  actionViewDkim,
  actionDnsOperations,
  actionDockerControl,
  actionToolbox,
} from './actions.js';

const ACTIONS = {
  add_domain: { label: 'Add domain / sub-domain', icon: '✚', color: '#4ade80', run: actionAddDomain },
  remove_domain: { label: 'Remove domain', icon: '✖', color: '#f87171', run: actionRemoveDomain },
  mailboxes: { label: 'Mailboxes & aliases', icon: '✉', color: '#f472b6', run: actionManageMailboxes },
  dkim: { label: 'DKIM keys', icon: '⚿', color: '#a78bfa', run: actionViewDkim },
  dns: { label: 'DNS health & sync', icon: '☁', color: '#818cf8', run: actionDnsOperations },
  docker: { label: 'Mail server container', icon: '▣', color: '#38bdf8', run: actionDockerControl },
  toolbox: { label: 'Toolbox ▸', icon: '⚒', color: '#fbbf24', run: actionToolbox },
} as const;

type ActionKey = keyof typeof ACTIONS;

async function mainLoop(dm: DomainManager): Promise<void> {
  await refreshDashboard(dm);

  while (true) {
    const choice = await ui.select<ActionKey | 'refresh' | 'exit'>('What do you want to do?', [
      { value: 'refresh', label: 'Refresh status & DNS', icon: '⟳', color: '#2dd4bf' },
      ...Object.entries(ACTIONS).map(([value, a]) => ({ value: value as ActionKey, label: a.label, icon: a.icon, color: a.color })),
      { value: 'exit', label: 'Exit', icon: '⏻', color: '#94a3b8' },
    ]);

    // Esc means "back" everywhere; at the top level there is nowhere to go back to.
    if (isCancel(choice)) continue;
    if (choice === 'exit') return;
    if (choice === 'refresh') {
      await refreshDashboard(dm);
      continue;
    }

    const action = ACTIONS[choice];
    ui.begin(action.label);
    try {
      await action.run(dm);
    } catch (err: any) {
      ui.error(err?.message ?? String(err));
    }
    // Refresh in the background so the menu is usable right away; the dashboard
    // shows a "refreshing" marker until live DNS comes back.
    void refreshDashboard(dm);
  }
}

export async function startTui(): Promise<void> {
  const instance = render(<App />, { exitOnCtrlC: true });
  const dm = new DomainManager();

  mainLoop(dm)
    .catch((err) => ui.error(`Fatal: ${err?.message ?? err}`))
    .finally(() => instance.unmount());

  await instance.waitUntilExit();
}
