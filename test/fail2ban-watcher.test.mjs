// aws-proxy/fail2ban-watcher.sh: log parsing, ban bookkeeping, and the SSH push. No network, SSH or Docker:
// a stub `ssh` on PATH records what would reach HAProxy's admin socket. Run: npm run test:f2b
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'aws-proxy', 'fail2ban-watcher.sh');
const line = (jail, verb, ip) => `2026-10-09 11:38:39,925 fail2ban.actions        [1166]: NOTICE  [${jail}] ${verb} ${ip}`;

function run(lines, { args = ['--stdin'], env = {}, sshExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'f2b-'));
  const rec = join(dir, 'ssh.rec');
  writeFileSync(join(dir, 'ssh'), `#!/bin/bash\necho "ARGS: $*" >> '${rec}'\ncat >> '${rec}'\nexit ${sshExit}\n`);
  chmodSync(join(dir, 'ssh'), 0o755);
  const r = spawnSync('bash', [script, ...args], {
    input: lines.join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PROXY_SSH_HOST: '203.0.113.9', ...env },
  });
  const sent = existsSync(rec) ? readFileSync(rec, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { ...r, sent, cmds: sent.split('\n').filter((l) => l.startsWith('set table')) };
}
const set = (ip, v) => `set table st_src key ${ip} data.gpc0 ${v}`;

// Ban, Restore Ban (fail2ban restart) and Unban are acted on; Found / unrelated lines are not.
let r = run([
  line('postfix', 'Ban', '187.155.200.21'),
  line('postfix', 'Restore Ban', '165.154.138.85'),
  '2026-10-14 12:59:07,879 fail2ban.filter         [276]: INFO    [postfix] Found 147.185.132.57 - 2026-10-14 12:59:07',
  'Oct 14 12:00:00 mail postfix/smtpd[1]: connect from unknown[1.2.3.4]',
  line('postfix', 'Unban', '165.154.138.85'),
]);
assert.equal(r.status, 0);
assert.deepEqual(r.cmds, [set('187.155.200.21', 1), set('165.154.138.85', 1), set('165.154.138.85', 0)]);
assert.match(r.sent, /ARGS: .*ubuntu@203\.0\.113\.9 sudo -n socat stdio UNIX-CONNECT:\/run\/haproxy\/admin\.sock/);

// An IP banned in two jails stays banned at HAProxy until the last jail releases it.
r = run([
  line('postfix', 'Ban', '187.155.200.21'),
  line('dovecot', 'Ban', '187.155.200.21'),
  line('postfix', 'Unban', '187.155.200.21'),
  line('dovecot', 'Unban', '187.155.200.21'),
]);
assert.deepEqual(r.cmds, [set('187.155.200.21', 1), set('187.155.200.21', 1), set('187.155.200.21', 0)]);

// Never push loopback / private / CGNAT (the compose network and cloudflared), IPv6, or malformed addresses.
r = run([
  ...['127.0.0.1', '172.25.0.11', '172.16.5.5', '10.1.2.3', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '256.1.1.1', '2001:db8::1'].map((ip) => line('dovecot', 'Ban', ip)),
  line('dovecot', 'Ban', '172.32.0.1'), // just outside 172.16/12: public
]);
assert.deepEqual(r.cmds, [set('172.32.0.1', 1)]);

// --dry-run prints the HAProxy commands and never calls ssh.
r = run([line('postfix', 'Ban', '187.155.200.21')], { args: ['--stdin', '--dry-run'], env: { PROXY_SSH_HOST: '' } });
assert.equal(r.status, 0);
assert.equal(r.sent, '');
assert.match(r.stdout, /\[dry-run\] haproxy> set table st_src key 187\.155\.200\.21 data\.gpc0 1/);

// A failing push is retried, then abandoned; the watcher keeps going and exits cleanly.
r = run([line('postfix', 'Ban', '187.155.200.21')], { sshExit: 255, env: { RETRY_DELAY: '0' } });
assert.equal(r.status, 0);
assert.equal(r.cmds.length, 3);
assert.match(r.stderr, /giving up on: set table st_src key 187\.155\.200\.21 data\.gpc0 1/);

// Config knobs reach the remote command.
r = run([line('postfix', 'Ban', '187.155.200.21')], { env: { PROXY_SSH_USER: 'admin', HAPROXY_TABLE: 'other', HAPROXY_SOCK: '/tmp/h.sock', PROXY_SSH_KEY: '/k/id' } });
assert.match(r.sent, /-i \/k\/id admin@203\.0\.113\.9 sudo -n socat stdio UNIX-CONNECT:\/tmp\/h\.sock/);
assert.deepEqual(r.cmds, ['set table other key 187.155.200.21 data.gpc0 1']);

// Without a host (and not dry-run) it refuses to start.
r = run([], { args: [], env: { PROXY_SSH_HOST: '' } });
assert.equal(r.status, 2);

// The HAProxy side: the stick-table stores gpc0 and every frontend rejects on it before the rate checks.
const cfg = readFileSync(join(dirname(script), 'haproxy.cfg'), 'utf8');
assert.match(cfg, /stick-table type ip .*store [^\n]*gpc0/);
for (const fe of ['imaps', 'smtps', 'submission']) {
  const block = cfg.split(/^frontend /m).find((b) => b.startsWith(fe));
  assert.ok(block, `frontend ${fe}`);
  const lines = block.split('\n').map((l) => l.trim());
  const ban = lines.findIndex((l) => l.includes('sc0_get_gpc0 gt 0'));
  const rate = lines.findIndex((l) => l.includes('sc0_conn_rate'));
  const track = lines.findIndex((l) => l.includes('track-sc0'));
  assert.ok(track >= 0 && ban > track && rate > ban, `${fe}: track-sc0, then gpc0 reject, then rate limit`);
}

console.log('fail2ban watcher: ok');
