// Renders the TUI with sample data at several terminal sizes and checks that every
// bordered box closes in the same column, nothing overflows, and the frame stays
// shorter than the terminal (else Ink falls back to clear-and-redraw).
// Run after `npm run build`: npm run test:tui
import React from 'react';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { App } from '../dist/tui/view.js';
import { ui, CANCEL } from '../dist/tui/ui.js';

const item = (status, records = ['sample']) => ({ status, records, expected: 'expected value' });
const zone = (name, status = 'active') => ({ id: name, name, status });
const ZONES = ['elite-athelete.com', 'netplug.me', 'pinpoint.host', 'switchboard.llc',
  ...Array.from({ length: 9 }, (_, i) => `extra-zone-${i}.com`)].map((n) => zone(n));
const DOMAINS = [
  { domain: 'switchboard.llc', isPrimary: true, mailboxCount: 3, dkimExists: false, dkimSelector: 'mail',
    dnsStatus: { mx: item('invalid'), spf: item('valid'), dkim: item('missing'), dmarc: item('valid') } },
  { domain: 'a-much-longer-subdomain.switchboard.llc', isPrimary: false, mailboxCount: 12, dkimExists: true,
    dkimSelector: 'mail',
    dnsStatus: { mx: item('valid'), spf: item('unknown'), dkim: item('valid'), dmarc: item('missing') } },
];
const ACCOUNTS = [
  ...['postmaster', 'lham', 'a-very-long-mailbox-name-for-testing'].map((u) => ({ email: `${u}@switchboard.llc`, username: u, domain: 'switchboard.llc' })),
  ...Array.from({ length: 30 }, (_, i) => ({ email: `user${i}@a-much-longer-subdomain.switchboard.llc`, username: `user${i}`, domain: 'a-much-longer-subdomain.switchboard.llc' })),
];
const ALIASES = [{ source: 'sales@switchboard.llc', destination: 'someone.with.a.long.address@example.com' }];
const USAGE = Object.fromEntries(ACCOUNTS.map((a, i) => [a.email, { user: a.email, usedKb: 1000 * i, limitKb: i % 2 ? 1048576 : undefined, messages: i }]));

ui.setDashboard({
  containerStatus: 'running', cloudflareConfigured: true,
  health: { bridge: 'running', tunnel: 'running', relay: true, certDays: 82 }, refreshedAt: new Date(),
  domains: DOMAINS, accounts: ACCOUNTS, aliases: ALIASES, usage: USAGE, zones: ZONES,
});
ui.begin('Delivery log');
for (let i = 0; i < 80; i++) ui.line(`log line ${i}`);

const SIZES = [[64, 30], [72, 24], [80, 24], [100, 30], [120, 40], [140, 50], [200, 60]];
const tick = (ms = 60) => new Promise((res) => setTimeout(res, ms));

function check(r, cols, rows, expect) {
  const lines = stripVTControlCharacters(r.lastFrame()).split('\n');
  const problems = [];
  let box = [];
  const closeBox = () => {
    if (box.length && (new Set(box.map(stringWidth)).size !== 1 || !box.every((l) => /[╮│╯]$/.test(l)))) {
      problems.push(`misaligned box:\n${box.join('\n')}`);
    }
    box = [];
  };
  for (const l of lines) {
    if (/^[╭│╰]/.test(l)) box.push(l.trimEnd());
    else closeBox();
    if (stringWidth(l) > cols) problems.push(`overflow (${stringWidth(l)} > ${cols}): ${l}`);
  }
  closeBox();
  if (lines.length >= rows) problems.push(`frame is ${lines.length} rows, terminal is ${rows}`);
  const frame = lines.join('\n');
  for (const needle of expect) if (!frame.includes(needle)) problems.push(`missing "${needle}"`);
  return { problems, frame };
}

let failures = 0;
const report = (name, { problems, frame }) => {
  console.log(`${name}: ${problems.length ? 'FAIL' : 'ok'}`);
  if (process.env.SHOW && name.startsWith(process.env.SHOW)) console.log(frame);
  for (const p of problems) console.log('  ' + p);
  failures += problems.length;
};

async function open(cols, rows) {
  const r = render(React.createElement(App, { dm: {} }));
  Object.defineProperty(r.stdout, 'columns', { value: cols });
  Object.defineProperty(r.stdout, 'rows', { value: rows });
  r.stdout.emit('resize');
  await tick();
  return r;
}

// Screens.
const SCREENS = [
  ['1', 'mailboxes', ['Mailboxes', '❯', 'ADDRESS']],
  ['2', 'domains', ['Domains', 'switchboard.llc', 'DOMAIN']],
  ['3', 'tools', ['Tools', 'Mail queue', 'log line 79']],
];
for (const [cols, rows] of SIZES) {
  for (const [key, name, expect] of SCREENS) {
    const r = await open(cols, rows);
    r.stdin.write(key);
    await tick();
    report(`${name} ${cols}x${rows}`, check(r, cols, rows, expect));
    r.unmount();
  }
}

// Dialogs and docked prompts, over the Mailboxes screen.
const DIALOGS = [
  ['form', () => ui.form('Add mailboxes', [
    { kind: 'select', key: 'domain', label: 'Domain', options: [{ value: 'a', label: 'a.example.com' }] },
    { kind: 'text', key: 'users', label: 'Name(s)', placeholder: 'sales, support', hint: 'Comma separated' },
    { kind: 'toggle', key: 'dns', label: 'Publish DNS', initial: true },
  ]), ['Add mailboxes', 'Domain', 'Name(s)', 'Publish DNS']],
  ['confirm', () => ui.confirm('Delete the mailbox someone@example.com?', { danger: true }), ['Are you sure?', 'Yes', 'No']],
  ['notice', () => ui.notice('Mailboxes created', [
    { kind: 'success', text: 'Created 2 mailboxes' },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: 'raw', text: `user${i}@example.com  ${'x'.repeat(16)}` })),
  ]), ['Mailboxes created', 'enter close']],
  ['select', () => ui.select('Queue action', [
    { value: 1, label: 'Refresh', icon: '⟳' }, { value: 2, label: 'Flush', icon: '➤' }, { value: 3, label: 'Back', icon: '←' },
  ]), ['Queue action', '❯ ', 'Flush']],
];
for (const [cols, rows] of SIZES) {
  for (const [name, open_, expect] of DIALOGS) {
    const r = await open(cols, rows);
    void open_();
    await tick();
    report(`dialog ${name} ${cols}x${rows}`, check(r, cols, rows, expect));
    r.unmount();
    // Resolve the pending prompt so the next one starts clean.
    ui.getState().prompt?.resolve(Symbol.for('x'));
  }
}

// The cursor must stay visible however far down the list it goes, with or without a dock.
for (const [cols, rows] of [[80, 24], [100, 30], [140, 50]]) {
  const r = await open(cols, rows);
  for (let i = 0; i < 40; i++) {
    r.stdin.write('\x1b[B');
    await tick(5);
  }
  await tick();
  const cursorRow = (frame) => frame.split('\n').some((l) => /❯ \S+@\S+/.test(l));
  let { problems, frame } = check(r, cols, rows, []);
  if (!cursorRow(frame)) problems.push('cursor row not visible at the end of the list');
  report(`scroll to end ${cols}x${rows}`, { problems, frame });
  r.stdin.write('\r'); // opens the actions dock
  await tick();
  ({ problems, frame } = check(r, cols, rows, ['Change password']));
  if (!cursorRow(frame)) problems.push('cursor row hidden when the dock is open');
  report(`scroll to end with dock ${cols}x${rows}`, { problems, frame });
  r.unmount();
  ui.getState().prompt?.resolve(CANCEL);
}
process.exit(failures ? 1 : 0);
