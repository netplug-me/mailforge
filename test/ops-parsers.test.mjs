// Parsers for postfix/dovecot/fail2ban/openssl output. Run after `npm run build`: npm run test:ops
import assert from 'node:assert/strict';
import { parseQueue, parseQuota, parseDelivery, parseWho, parseBanned, parseCert, formatKb } from '../dist/services/ops.js';

const q = parseQueue(
  '{"queue_name": "deferred", "queue_id": "ABC123", "arrival_time": 1790916000, "message_size": 2048, "sender": "a@x.com", "recipients": [{"address": "b@y.com", "delay_reason": "connect timed out"}]}\nnot json\n'
);
assert.equal(q.length, 1);
assert.equal(q[0].reason, 'connect timed out');
assert.deepEqual(q[0].recipients, ['b@y.com']);
assert.equal(parseQueue('').length, 0);

const quota = parseQuota(`Username                   Quota name Type    Value   Limit          %
lham@switchboard.llc       user       STORAGE     8 5242880          0
lham@switchboard.llc       user       MESSAGE     1       -          0
postmaster@switchboard.llc user       STORAGE    10       -          0
`);
assert.equal(quota.length, 2);
assert.deepEqual(quota[0], { user: 'lham@switchboard.llc', usedKb: 8, limitKb: 5242880, messages: 1 });
assert.equal(quota[1].limitKb, undefined);
assert.equal(formatKb(5242880), '5.0G');
assert.equal(formatKb(512), '512K');

const log = [
  '2026-10-01T22:45:37.522004-06:00 mail postfix/smtp[1823]: 95E: to=<ben@yahoo.com>, relay=smtp.postmarkapp.com[3.95.122.1]:587, delay=0.92, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as 6A59)',
  '2026-10-01T22:47:53.358183-06:00 mail postfix/smtp-amavis/smtp[2138]: A17: to=<l@x.llc>, relay=127.0.0.1[127.0.0.1]:10024, status=sent (250 ok)',
  '2026-10-01T22:47:53.414366-06:00 mail postfix/lmtp[2144]: 549: to=<l@x.llc>, relay=mail.x.llc[/var/run/dovecot/lmtp], status=sent (250 Saved)',
  '2026-10-01T22:48:00.000000-06:00 mail postfix/smtp[9]: BAD: to=<z@gone.com>, relay=mx.gone.com[1.2.3.4]:25, status=bounced (550 no such user)',
].join('\n');
const d = parseDelivery(log);
assert.deepEqual(d.map((r) => r.status), ['sent', 'sent', 'bounced']);
assert.equal(d[0].time, '22:45:37');
assert.equal(d[2].detail, '550 no such user');

const who = parseWho('username # service (pids) (ips)\nlham@switchboard.llc 2 imap (12 13) (10.0.0.5)\n');
assert.deepEqual(who, [{ user: 'lham@switchboard.llc', connections: 2, service: 'imap', ips: '10.0.0.5' }]);
assert.equal(parseWho('username # service (pids) (ips)   \n').length, 0);

const banned = parseBanned("[{'postfix': ['1.2.3.4', '5.6.7.8']}, {'dovecot': []}, {'custom': []}]");
assert.deepEqual(banned, [
  { jail: 'postfix', ips: ['1.2.3.4', '5.6.7.8'] },
  { jail: 'dovecot', ips: [] },
  { jail: 'custom', ips: [] },
]);

const cert = parseCert("notAfter=Dec 22 05:54:14 2026 GMT\nissuer=C=US, O=Let's Encrypt, CN=YE1\n", new Date('2026-10-01T00:00:00Z'));
assert.equal(cert.daysLeft, 82);
assert.equal(cert.issuer, 'YE1');
assert.equal(parseCert('garbage'), undefined);

console.log('ops parsers: ok');
