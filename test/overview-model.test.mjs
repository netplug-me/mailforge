// Live-feed parsing (mail.log / fail2ban.log classification, stats) and the Overview's pure helpers.
// Fixtures use example.com and documentation-range IPs. Run after `npm run build`: npm run test:overview
import assert from 'node:assert/strict';
import { parseMailLog, computeLogStats, parseFail2banLog, parseSections, parseLive, parseContainerStats } from '../dist/services/ops.js';
import { sparkline, formatSpan, collapse, logRows, mailRows, banRows, f2bFeed, pulseTiles } from '../dist/tui/overview-model.js';

const L = (t, rest) => `2026-10-14T${t}.100000-06:00 mail ${rest}`;
const LOG = [
  // health checks from cloudflared: noise
  L('10:00:05', 'postfix/submission/smtpd[1]: connect from cf-mail-tui-cloudflared-1.cf-mail-tui_default[172.25.0.11]'),
  L('10:00:05', 'postfix/submission/smtpd[1]: NOQUEUE: lost connection after CONNECT from cf-mail-tui-cloudflared-1.cf-mail-tui_default[172.25.0.11]'),
  L('10:00:15', 'dovecot: imap-login: Login aborted: Connection closed (disconnected during TLS handshake) (tls_handshake_not_finished): user=<>, rip=172.25.0.11, lip=172.25.0.10'),
  L('10:00:25', 'opendmarc[234]: ignoring connection from cloudflared-1.cf-mail-tui_default'),
  // real traffic
  L('10:01:00', 'dovecot: imap-login: Logged in: user=<alice@example.com>, method=PLAIN, rip=203.0.113.5, lip=10.0.0.1, TLS, session=<abc>'),
  L('10:02:00', 'amavis[9]: (00009-01) Passed CLEAN {RelayedInbound}, [10.0.0.9]:1 [198.51.100.7] <news@sender.example> -> <alice@example.com>, Queue-ID: AAA, Message-ID: <x@y>'),
  L('10:02:30', 'amavis[9]: (00009-02) Blocked SPAM {DiscardedInbound}, [10.0.0.9]:1 [198.51.100.8] <spam@bad.example> -> <alice@example.com>, Queue-ID: BBB'),
  L('10:03:00', 'postfix/smtp[5]: CCC: to=<bob@gmail.example>, relay=smtp.relay.example[192.0.2.1]:587, delay=1, dsn=2.0.0, status=sent (250 OK)'),
  L('10:03:10', 'postfix/smtp[5]: DDD: to=<carol@gmail.example>, relay=smtp.relay.example[192.0.2.1]:587, delay=1, dsn=5.1.1, status=bounced (550 no such user)'),
  L('10:03:20', 'postfix/smtp[5]: EEE: to=<dave@slow.example>, relay=mx.slow.example[192.0.2.2]:25, delay=9, dsn=4.4.1, status=deferred (connect timed out)'),
  // internal hops: not mail movements
  L('10:03:30', 'postfix/smtp-amavis/smtp[6]: FFF: to=<alice@example.com>, relay=127.0.0.1[127.0.0.1]:10024, delay=1, dsn=2.0.0, status=sent (250 ok)'),
  L('10:03:31', 'postfix/lmtp[7]: GGG: to=<alice@example.com>, relay=mail.example.com[/var/run/dovecot/lmtp], delay=1, dsn=2.0.0, status=sent (250 Saved)'),
  L('10:04:00', 'postfix/smtpd[8]: NOQUEUE: reject: RCPT from unknown[203.0.113.9]: 550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown in virtual mailbox table; from=<a@b.example> to=<nobody@example.com> proto=ESMTP'),
  L('10:05:00', 'postfix/submissions/smtpd[8]: SSL_accept error from scanner.example[203.0.113.10]: -1'),
  L('10:05:00', 'postfix/submissions/smtpd[8]: warning: TLS library problem: error:0A00010B:SSL routines::wrong version number'),
  L('10:05:01', 'postfix/submissions/smtpd[8]: SSL_accept error from scanner.example[203.0.113.10]: -1'),
  L('10:06:00', 'postfix/submission/smtpd[8]: improper command pipelining after CONNECT from unknown[203.0.113.11]: GET / HTTP/1.1'),
  L('10:07:00', 'dovecot: imap-login: Login aborted: Connection closed (no auth attempts in 0 secs) (no_auth_attempts): user=<>, rip=203.0.113.12, lip=10.0.0.1, TLS'),
  L('10:08:00', 'dovecot: auth: passwd-file(alice@example.com,203.0.113.13): unknown user'),
  L('10:08:30', 'postfix/smtpd[8]: warning: unknown[203.0.113.14]: SASL LOGIN authentication failed: UGFzc3dvcmQ6'),
  L('10:09:00', 'postfix/anvil[3]: statistics: max connection rate 2/60s for (465:203.0.113.10) at Oct 14 10:05:00'),
  L('10:10:00', 'postfix/master[2]: daemon started -- version 3.10, configuration /etc/postfix'),
  'garbage line that is not a log line',
].join('\n');

const events = parseMailLog(LOG);
const by = (cls) => events.filter((e) => e.cls === cls);

// Health checks are tagged noise, never mail or probes.
assert.equal(by('noise').length, 5); // 4 cloudflared lines + the TLS library warning
assert.ok(events.every((e) => !(e.cls === 'probe' && e.ip === '172.25.0.11')));

// Mail movements.
assert.deepEqual(by('in').map((e) => [e.who, e.via]), [['news@sender.example', 'alice@example.com']]);
assert.equal(by('blocked').length, 1);
assert.match(by('out')[0].text, /bob@gmail\.example/);
assert.equal(by('out')[0].via, 'smtp.relay.example');
assert.equal(by('bounce')[0].who, 'carol@gmail.example');
assert.equal(by('defer')[0].who, 'dave@slow.example');
// 127.0.0.1 and lmtp hops are internal, so they do not count as sent mail.
assert.equal(by('out').length, 1);

// Security events.
assert.equal(by('login').length, 1);
assert.deepEqual([by('login')[0].who, by('login')[0].ip], ['alice@example.com', '203.0.113.5']);
assert.equal(by('reject').length, 1);
assert.match(by('reject')[0].text, /550 5\.1\.1/);
assert.equal(by('reject')[0].ip, '203.0.113.9');
assert.deepEqual(by('probe').map((e) => e.ip), ['203.0.113.10', '203.0.113.10', '203.0.113.11', '203.0.113.12']);
assert.match(by('probe')[3].text, /imap-login connection from 203\.0\.113\.12.*no auth attempts/);
assert.equal(by('authfail').length, 1);
assert.equal(by('system').length, 1);
assert.equal(by('session').length, 3); // amavis-less internal hops (2) + anvil statistics
assert.equal(events.some((e) => e.text.includes('garbage')), false);

// Stats: span (first to last stamped line), counts, buckets, unique probing IPs.
const stats = computeLogStats(events, 4);
assert.equal(stats.spanMs, (9 * 60 + 55) * 1000); // 10:00:05 → 10:10:00
assert.equal(stats.counts.out, 1);
assert.equal(stats.probeIps, 3);
assert.equal(stats.mail.reduce((a, b) => a + b, 0), 4); // in + out + bounce + defer
assert.equal(stats.threats.reduce((a, b) => a + b, 0), 6); // 4 probes + auth failure + reject
assert.equal(stats.mail.length, 4);
assert.equal(computeLogStats([]).spanMs, 0);

// fail2ban log.
const F2B = [
  '2026-10-14 12:05:38,096 fail2ban.actions        [276]: NOTICE  [postfix] Restore Ban 203.0.113.20',
  '2026-10-14 12:59:07,879 fail2ban.filter         [276]: INFO    [postfix] Found 203.0.113.21 - 2026-10-14 12:59:07',
  '2026-10-14 12:59:09,879 fail2ban.filter         [276]: INFO    [postfix] Found 203.0.113.21 - 2026-10-14 12:59:09',
  '2026-10-14 13:00:00,000 fail2ban.actions        [276]: NOTICE  [dovecot] Ban 203.0.113.21',
  '2026-10-14 14:00:00,000 fail2ban.actions        [276]: NOTICE  [dovecot] Unban 203.0.113.21',
  '2026-10-14 14:00:01,000 fail2ban.server         [276]: INFO    Jail started',
].join('\n');
const f2b = parseFail2banLog(F2B);
assert.deepEqual(f2b.map((e) => [e.action, e.jail, e.ip]), [
  ['ban', 'postfix', '203.0.113.20'], ['found', 'postfix', '203.0.113.21'], ['found', 'postfix', '203.0.113.21'],
  ['ban', 'dovecot', '203.0.113.21'], ['unban', 'dovecot', '203.0.113.21'],
]);
assert.equal(f2b[0].when, '10-14 12:05:38');
// Newest first, with repeated strikes folded.
const feed = f2bFeed(f2b, 10);
assert.deepEqual(feed.map((e) => [e.action, e.count]), [['unban', 1], ['ban', 1], ['found', 2], ['ban', 1]]);
assert.equal(f2bFeed(f2b, 2).length, 2);

// Bans merge across jails.
const live = {
  at: new Date(), events, raw: events.slice(0, 4), stats, f2bEvents: f2b,
  jails: [{ jail: 'postfix', ips: ['203.0.113.20', '203.0.113.30'] }, { jail: 'dovecot', ips: ['203.0.113.30'] }, { jail: 'custom', ips: [] }],
  queue: { total: 3, deferred: 2, active: 1 }, clients: [{ user: 'alice@example.com', connections: 2, service: 'imap', ips: '203.0.113.5' }],
};
assert.deepEqual(banRows(live), [{ ip: '203.0.113.20', jails: ['postfix'] }, { ip: '203.0.113.30', jails: ['postfix', 'dovecot'] }]);
assert.deepEqual(banRows(undefined), []);

// Mail rows: newest first, internal hops excluded, direction and via set.
const rows = mailRows(live, 10, new Date('2026-10-14T12:00:00-06:00'));
assert.deepEqual(rows.map((r) => r.cls), ['defer', 'bounce', 'out', 'blocked', 'in']);
assert.equal(rows[2].dir, 'out');
assert.equal(rows[4].dir, 'in');
assert.equal(rows[4].via, '→ alice@example.com');
assert.equal(rows[4].when, '10:02:00'); // same day: time only
assert.match(mailRows(live, 10, new Date('2026-10-20T12:00:00-06:00'))[0].when, /^10-14 10:03$/); // other day: date + HH:MM
assert.equal(mailRows(live, 2).length, 2);

// Log filters: signal hides noise and session chatter, problems keeps only trouble, raw shows everything.
const sig = logRows(live, 0);
assert.ok(sig.every((r) => r.cls !== 'noise' && r.cls !== 'session'));
assert.ok(sig.some((r) => r.cls === 'out'));
const prob = logRows(live, 1);
assert.deepEqual([...new Set(prob.map((r) => r.cls))].sort(), ['authfail', 'blocked', 'bounce', 'defer', 'probe', 'reject']);
assert.equal(logRows(live, 2).length, collapse(live.raw).length);
assert.deepEqual(logRows(undefined, 0), []);
// Identical neighbours collapse and keep the latest time; the filter index wraps.
const tls = collapse(events.filter((e) => e.cls === 'probe' && e.ip === '203.0.113.10'));
assert.equal(tls.length, 1);
assert.equal(tls[0].count, 2);
assert.equal(tls[0].time, '10:05:01');
assert.equal(logRows(live, 3).length, sig.length);

// Tiles.
const tiles = Object.fromEntries(pulseTiles(live, 20).map((t) => [t.label, t]));
assert.equal(tiles.RECEIVED.value, '1');
assert.equal(tiles.SENT.value, '1');
assert.equal(tiles['BOUNCED/REJ'].value, '4'); // bounce + defer + blocked + reject
assert.equal(tiles.QUEUE.sub, '2 deferred');
assert.equal(tiles.PROBES.sub, '3 IPs');
assert.equal(tiles.BANNED.value, '2');
assert.equal(tiles.ONLINE.value, '1');
assert.equal(tiles.CERT.value, '20d');
assert.equal(pulseTiles(undefined).find((t) => t.label === 'SENT').value, '—');

// Sparkline: scaled to the series max, one block per column.
assert.equal(sparkline([0, 0, 0, 0], 4), '▁▁▁▁');
assert.equal(sparkline([0, 1, 0, 8], 4), '▁▂▁█');
assert.equal(sparkline([1, 1, 1, 1, 4, 4, 4, 4], 2), '▃█');
assert.equal(sparkline([], 3), '▁▁▁');
assert.equal(sparkline([5], 0), '');
assert.equal([...sparkline([3, 1, 4, 1, 5, 9, 2, 6], 8)].length, 8);

// Durations.
assert.equal(formatSpan(0), '—');
assert.equal(formatSpan(45_000), '45s');
assert.equal(formatSpan(90 * 60_000), '1h 30m');
assert.equal(formatSpan((3 * 24 + 8) * 3_600_000), '3d 8h');

// Sections, container stats and the combined parse.
assert.deepEqual(parseSections('noise\n@@A\nx\ny\n@@B\nz\n'), { A: 'x\ny\n', B: 'z\n' });
assert.deepEqual(parseContainerStats('1.29%|1.433GiB / 29.03GiB|4.94%\n'), { cpu: '1.29%', mem: '1.433GiB', memPct: 4.94 });
assert.equal(parseContainerStats(''), undefined);
const parsed = parseLive([
  '@@LOG', LOG, '@@RAW', L('10:11:00', 'dovecot: imap-login: Logged in: user=<a@example.com>, rip=203.0.113.5'),
  '@@F2B', F2B, '@@BANNED', "[{'postfix': ['203.0.113.20']}, {'dovecot': []}]",
  '@@QUEUE', '{"queue_name": "deferred", "queue_id": "A1", "arrival_time": 1790916000, "message_size": 10, "sender": "a@example.com", "recipients": [{"address": "b@example.com"}]}',
  '@@WHO', 'username # service (pids)  (ips)\nalice@example.com 1 imap (123) (203.0.113.5)',
  '@@LOAD', '0.30 0.19 0.22 1/1085 46310',
].join('\n'), new Date('2026-10-14T12:00:00Z'));
assert.equal(parsed.raw.length, 1);
assert.deepEqual(parsed.queue, { total: 1, deferred: 1, active: 0 });
assert.deepEqual(parsed.jails, [{ jail: 'postfix', ips: ['203.0.113.20'] }, { jail: 'dovecot', ips: [] }]);
assert.equal(parsed.clients.length, 1);
assert.equal(parsed.load, '0.30 0.19 0.22');
// A mail server that is not answering leaves the optional parts undefined instead of throwing.
const down = parseLive('@@LOG\n@@BANNED\nOCI runtime exec failed\n@@QUEUE\npostqueue: fatal: Cannot open\n@@WHO\ndoveadm(who): Error: x\n');
assert.equal(down.jails, undefined);
assert.equal(down.queue, undefined);
assert.deepEqual(down.clients, []);

console.log('overview model: ok');
