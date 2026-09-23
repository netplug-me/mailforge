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
ui.setDashboard({
  containerStatus: 'running',
  cloudflareConfigured: true,
  refreshedAt: new Date(),
  domains: [
    { domain: 'switchboard.llc', isPrimary: true, mailboxCount: 1, dkimExists: false, dkimSelector: 'mail',
      dnsStatus: { mx: item('invalid'), spf: item('valid'), dkim: item('missing'), dmarc: item('valid') } },
    { domain: 'a-much-longer-subdomain.switchboard.llc', isPrimary: false, mailboxCount: 12, dkimExists: true,
      dkimSelector: 'mail',
      dnsStatus: { mx: item('valid'), spf: item('unknown'), dkim: item('valid'), dmarc: item('missing') } },
  ],
});
ui.begin('DKIM · switchboard.llc');
ui.success('DKIM key generated');
ui.raw('v=DKIM1; k=rsa; p=' + 'A'.repeat(300));
for (let i = 0; i < 60; i++) ui.line(`log line ${i}`);
ui.select('What do you want to do?', ['Refresh', 'Add', 'Remove', 'Exit'].map((l) => ({ value: l, label: l })));

let failures = 0;
for (const [cols, rows] of [[80, 24], [80, 30], [100, 40], [140, 50], [200, 60]]) {
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

  console.log(`${cols}x${rows}: ${problems.length ? 'FAIL' : 'ok'}`);
  for (const p of problems) console.log('  ' + p);
  failures += problems.length;
  r.unmount();
}
process.exit(failures ? 1 : 0);
