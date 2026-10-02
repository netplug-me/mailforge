// Renders the TUI with sample data at several terminal sizes and checks that every
// bordered box closes in the same column, nothing overflows, and the frame stays
// shorter than the terminal (else Ink falls back to clear-and-redraw).
// Run after `npm run build`: npm run test:tui
import React from 'react';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { App } from '../dist/tui/view.js';
import { ui } from '../dist/tui/ui.js';

const item = (status) => ({ status, records: [] });
const zone = (name, status = 'active') => ({ id: name, name, status });
const FEW_ZONES = ['elite-athelete.com', 'netplug.me', 'pinpoint.host', 'switchboard.llc'].map((n) => zone(n));
const MANY_ZONES = [...FEW_ZONES, zone('pending-example.org', 'pending'),
  ...Array.from({ length: 7 }, (_, i) => zone(`extra-zone-${i}.com`))];
const DOMAINS = [
    { domain: 'switchboard.llc', isPrimary: true, mailboxCount: 1, dkimExists: false, dkimSelector: 'mail',
      dnsStatus: { mx: item('invalid'), spf: item('valid'), dkim: item('missing'), dmarc: item('valid') } },
    { domain: 'a-much-longer-subdomain.switchboard.llc', isPrimary: false, mailboxCount: 12, dkimExists: true,
      dkimSelector: 'mail',
      dnsStatus: { mx: item('valid'), spf: item('unknown'), dkim: item('valid'), dmarc: item('missing') } },
];
const setDashboard = (zones) =>
  ui.setDashboard({ containerStatus: 'running', cloudflareConfigured: true,
    health: { bridge: 'running', tunnel: 'running', relay: true, certDays: 82 }, refreshedAt: new Date(), domains: DOMAINS, zones });
ui.begin('DKIM · switchboard.llc');
ui.success('DKIM key generated');
ui.raw('v=DKIM1; k=rsa; p=' + 'A'.repeat(300));
for (let i = 0; i < 60; i++) ui.line(`log line ${i}`);
// Same size as the real main menu.
const MENU = ['Refresh status & DNS', 'Add domain / sub-domain', 'Remove domain', 'Mailboxes & aliases', 'DKIM keys',
  'DNS health & sync', 'Mail server container', 'Toolbox ▸', 'Exit'];
ui.select('What do you want to do?', MENU.map((l) => ({ value: l, label: l })));
const MIN_VISIBLE_OUTPUT = 5;

let failures = 0;
for (const zones of [FEW_ZONES, MANY_ZONES]) {
setDashboard(zones);
for (const [cols, rows] of [[64, 30], [72, 24], [76, 24], [80, 24], [80, 26], [80, 30], [100, 40], [140, 50], [200, 60]]) {
  const r = render(React.createElement(App));
  Object.defineProperty(r.stdout, 'columns', { value: cols });
  Object.defineProperty(r.stdout, 'rows', { value: rows });
  r.stdout.emit('resize');
  await new Promise((res) => setTimeout(res, 50));

  const lines = stripVTControlCharacters(r.lastFrame()).split('\n');
  const problems = [];
  let box = [];
  const checkBox = () => {
    if (box.length && (new Set(box.map(stringWidth)).size !== 1 || !box.every((l) => /[╮│╯]$/.test(l)))) {
      problems.push(`misaligned box:\n${box.join('\n')}`);
    }
    box = [];
  };
  for (const l of lines) {
    if (/^[╭│╰]/.test(l)) box.push(l.trimEnd());
    else checkBox();
    if (stringWidth(l) > cols) problems.push(`overflow (${stringWidth(l)} > ${cols}): ${l}`);
  }
  checkBox();
  if (lines.length >= rows) problems.push(`frame is ${lines.length} rows, terminal is ${rows}`);
  const visibleOutput = lines.filter((l) => /log line \d+/.test(l)).length;
  if (visibleOutput < MIN_VISIBLE_OUTPUT) problems.push(`only ${visibleOutput} output line(s) visible`);
  const menuVisible = lines.some((l) => /❯ (\S+ )?Refresh/.test(l));
  if (!menuVisible) problems.push('menu cursor not visible');
  // Every zone is either listed or counted in "+N more".
  const frame = lines.join('\n');
  const listed = zones.filter((z) => frame.includes(z.name)).length;
  const more = Number(frame.match(/\+(\d+) more/)?.[1] ?? 0);
  if (listed + more !== zones.length) problems.push(`zones: ${listed} listed + ${more} more != ${zones.length}`);
  if (!frame.includes('● switchboard.llc')) problems.push('switchboard.llc not marked as a mail zone');

  console.log(`${zones.length} zones ${cols}x${rows}: ${problems.length ? 'FAIL' : 'ok'} (${visibleOutput} output lines visible)`);
  if (process.env.SHOW && `${cols}x${rows}` === process.env.SHOW && zones === FEW_ZONES) console.log(frame);
  for (const p of problems) console.log('  ' + p);
  failures += problems.length;
  r.unmount();
}
}
process.exit(failures ? 1 : 0);
