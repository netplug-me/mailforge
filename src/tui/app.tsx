import React from 'react';
import { render } from 'ink';
import { DomainManager } from '../services/domain-manager.js';
import { refreshDashboard, startLive } from './dashboard.js';
import { App } from './view.js';
import { ui } from './ui.js';

export async function startTui(): Promise<void> {
  const dm = new DomainManager();
  const instance = render(<App dm={dm} />, { exitOnCtrlC: true, alternateScreen: true });

  refreshDashboard(dm).catch((err) => ui.toast('error', `Refresh failed: ${err?.message ?? err}`, 10000));

  const stopLive = startLive();
  await instance.waitUntilExit();
  stopLive();
}
