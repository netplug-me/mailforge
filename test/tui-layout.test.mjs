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
import { parseMailLog, computeLogStats } from '../dist/services/ops.js';

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

// Overview data: a mix of mail, probes and noise, long enough to scroll.
const logLine = (i, rest) => `2026-10-14T${String(8 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000000-06:00 mail ${rest}`;
const LIVE_EVENTS = parseMailLog(Array.from({ length: 150 }, (_, i) => [
  logLine(i, `postfix/smtp[1]: ABC${i}: to=<person${i}@some-rather-long-domain.example.com>, relay=smtp.relay.example[192.0.2.1]:587, dsn=2.0.0, status=sent (250 OK)`),
  logLine(i, `amavis[9]: (00009-01) Passed CLEAN {RelayedInbound}, [10.0.0.9]:1 [198.51.100.7] <sender${i}@long-sender-domain.example> -> <user${i % 5}@a-much-longer-subdomain.switchboard.llc>, Queue-ID: AAA`),
  logLine(i, `postfix/submissions/smtpd[8]: SSL_accept error from scanner.example[203.0.113.${i % 250}]: -1`),
  logLine(i, 'dovecot: imap-login: Logged in: user=<lham@switchboard.llc>, method=PLAIN, rip=203.0.113.5, lip=10.0.0.1, TLS'),
  logLine(i, 'postfix/submission/smtpd[1]: connect from cf-mail-tui-cloudflared-1.cf-mail-tui_default[172.25.0.11]'),
].join('\n')).join('\n'));
const LIVE = {
  at: new Date(), events: LIVE_EVENTS.filter((e) => e.cls !== 'noise'), raw: LIVE_EVENTS.slice(-200),
  stats: computeLogStats(LIVE_EVENTS.filter((e) => e.cls !== 'noise')),
  f2bEvents: Array.from({ length: 8 }, (_, i) => ({ when: `10-14 12:0${i}:00`, jail: i % 2 ? 'dovecot' : 'postfix', action: ['ban', 'found', 'unban'][i % 3], ip: `203.0.113.${20 + i}` })),
  jails: [{ jail: 'postfix', ips: ['203.0.113.20', '203.0.113.21', '203.0.113.22', '203.0.113.23', '203.0.113.24'] }, { jail: 'dovecot', ips: ['203.0.113.21'] }],
  queue: { total: 4, deferred: 3, active: 1 }, clients: [{ user: 'lham@switchboard.llc', connections: 2, service: 'imap', ips: '203.0.113.5' }],
  load: '0.30 0.19 0.22', watcher: 'active', startedAt: new Date(Date.now() - 7_300_000), container: { cpu: '1.29%', mem: '1.4GiB', memPct: 4.9 },
};

ui.setDashboard({
  containerStatus: 'running', cloudflareConfigured: true,
  health: { bridge: 'running', tunnel: 'running', relay: true, certDays: 82 }, refreshedAt: new Date(),
  domains: DOMAINS, accounts: ACCOUNTS, aliases: ALIASES, usage: USAGE, zones: ZONES, live: LIVE,
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
  ['1', 'overview', ['Pulse', 'Recent mail', 'Live log', 'RECEIVED']],
  ['2', 'mailboxes', ['Mailboxes', '❯', 'ADDRESS']],
  ['3', 'domains', ['Domains', 'switchboard.llc', 'DOMAIN']],
  ['4', 'tools', ['Tools', 'Mail queue', 'log line 79']],
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

// Overview: side panels on wide terminals, every log filter, and scrolling the log.
for (const [cols, rows] of SIZES) {
  const r = await open(cols, rows);
  const wide = cols >= 84 && rows >= 24;
  report(`overview panels ${cols}x${rows}`, check(r, cols, rows, wide ? ['Bans · 5', 'proxy sync'] : []));
  for (const [i, name] of [[1, 'problems'], [2, 'raw'], [0, 'signal']]) {
    r.stdin.write('f');
    await tick();
    report(`overview filter ${name} ${cols}x${rows}`, check(r, cols, rows, [`Live log · ${name}`]));
  }
  for (let n = 0; n < 5; n++) r.stdin.write('\x1b[A');
  r.stdin.write('\x1b[5~');
  await tick();
  report(`overview scrolled ${cols}x${rows}`, check(r, cols, rows, ['newer below']));
  r.stdin.write('G');
  await tick();
  report(`overview follow ${cols}x${rows}`, check(r, cols, rows, ['following']));
  r.unmount();
}
// Without any live data (mail server down) the screen still lays out and says it is waiting.
{
  const saved = ui.getState().dashboard;
  ui.setDashboard({ ...saved, live: undefined });
  for (const [cols, rows] of [[64, 30], [80, 24], [140, 50]]) {
    const r = await open(cols, rows);
    report(`overview empty ${cols}x${rows}`, check(r, cols, rows, ['Waiting for the mail server']));
    r.unmount();
  }
  ui.setDashboard(saved);
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
    r.stdin.write('2');
    await tick();
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
  r.stdin.write('2');
  await tick();
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
