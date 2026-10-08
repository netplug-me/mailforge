// Drives the TUI flows with a fake mail server (no Docker, no Cloudflare) by answering
// each prompt programmatically. Run after `npm run build`: npm run test:flows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

// Keep the flows' post-action refresh away from the real project.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-flows-'));
process.env.DMS_PROJECT_DIR = tmp;
delete process.env.CF_API_TOKEN;
delete process.env.CLOUDFLARE_API_TOKEN;

const { ui, CANCEL } = await import('../dist/tui/ui.js');
const flows = await import('../dist/tui/flows.js');

const calls = [];
const ctx = {
  dm: { getAllDomains: () => ['a.com', 'b.org'], listDomains: async () => [] },
  dms: {
    listAccounts: () => [{ email: 'taken@a.com', username: 'taken', domain: 'a.com' }],
    runSetupAsync: async (args) => {
      calls.push(args);
      return { code: 0, stdout: '', stderr: '', success: true };
    },
    verifyLogin: async () => true,
    deleteMailData: async (email) => {
      calls.push(['rm-data', email]);
      return { code: 0, stdout: '', stderr: '', success: true };
    },
  },
};

/** Answers the next prompt the flow raises. */
async function answer(fn) {
  for (let i = 0; i < 200; i++) {
    const p = ui.getState().prompt;
    if (p) return fn(p);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no prompt appeared');
}

let n = 0;
const test = async (name, fn) => {
  calls.length = 0;
  await fn();
  console.log(`ok - ${name}`);
  n++;
};

await test('add mailboxes: generates passwords, sets quota, skips existing', async () => {
  const flow = flows.addMailboxFlow(ctx, 'a.com');
  const form = await answer((p) => {
    assert.equal(p.kind, 'form');
    assert.equal(p.fields[0].options.length, 2);
    // The context domain is preselected.
    assert.equal(p.fields[0].initial, 'a.com');
    assert.equal(p.fields[1].validate('bad name!'), '"name!" is not a valid mailbox name');
    assert.equal(p.fields[1].validate(''), 'Enter at least one name');
    assert.equal(p.fields[3].validate('lots'), 'Use a size such as 500M or 2G');
    p.resolve({ domain: 'a.com', users: 'sales, Support, taken', password: '', quota: '2g' });
    return p;
  });
  assert.ok(form);
  const notice = await answer((p) => {
    assert.equal(p.kind, 'notice');
    const text = p.lines.map((l) => l.text).join('\n');
    assert.match(text, /Created 2 mailboxes/);
    assert.match(text, /sales@a\.com\s+\S{16}/);
    assert.match(text, /support@a\.com\s+\S{16}/);
    assert.match(text, /taken@a\.com already exists/);
    assert.match(text, /Test login accepted for 2 mailbox/);
    p.resolve();
    return text;
  });
  await flow;
  const adds = calls.filter((c) => c[0] === 'email' && c[1] === 'add');
  assert.deepEqual(adds.map((c) => c[2]), ['sales@a.com', 'support@a.com']);
  assert.notEqual(adds[0][3], adds[1][3]);
  assert.deepEqual(calls.filter((c) => c[0] === 'quota').map((c) => c.slice(0, 4)), [
    ['quota', 'set', 'sales@a.com', '2G'],
    ['quota', 'set', 'support@a.com', '2G'],
  ]);
  assert.ok(notice);
});

await test('add mailboxes: a given password is used as is', async () => {
  const flow = flows.addMailboxFlow(ctx);
  await answer((p) => p.resolve({ domain: 'b.org', users: 'ops', password: 'correct horse', quota: '' }));
  await answer((p) => p.resolve());
  await flow;
  assert.deepEqual(calls[0], ['email', 'add', 'ops@b.org', 'correct horse']);
  assert.equal(calls.length, 1);
});

await test('cancelling a form changes nothing', async () => {
  const flow = flows.addMailboxFlow(ctx);
  await answer((p) => p.resolve(CANCEL));
  await flow;
  assert.equal(calls.length, 0);
});

await test('delete mailbox: cancel, keep mail, or delete mail', async () => {
  const cancelled = flows.deleteAccountFlow(ctx, 'x@a.com');
  await answer((p) => {
    assert.equal(p.kind, 'form');
    assert.equal(p.danger, true);
    assert.equal(p.fields[0].initial, false);
    p.resolve(CANCEL);
  });
  await cancelled;
  assert.equal(calls.length, 0);

  const kept = flows.deleteAccountFlow(ctx, 'x@a.com');
  await answer((p) => p.resolve({ data: false }));
  await kept;
  assert.deepEqual(calls, [['email', 'del', 'x@a.com']]);
  assert.match(ui.getState().toast.text, /stored mail was kept/);

  calls.length = 0;
  const wiped = flows.deleteAccountFlow(ctx, 'x@a.com');
  await answer((p) => p.resolve({ data: true }));
  await wiped;
  assert.deepEqual(calls, [['email', 'del', 'x@a.com'], ['rm-data', 'x@a.com']]);
  assert.match(ui.getState().toast.text, /stored mail was deleted/);
});

await test('change password: typed vs generated', async () => {
  const typed = flows.resetPasswordFlow(ctx, 'x@a.com');
  await answer((p) => p.resolve({ password: 'hunter2hunter2' }));
  await typed;
  assert.deepEqual(calls, [['email', 'update', 'x@a.com', 'hunter2hunter2']]);
  calls.length = 0;
  const generated = flows.resetPasswordFlow(ctx, 'x@a.com');
  await answer((p) => p.resolve({ password: '' }));
  await answer((p) => {
    assert.equal(p.kind, 'notice');
    assert.match(p.lines[1].text, /^\S{16}$/);
    p.resolve();
  });
  await generated;
  assert.equal(calls[0][3].length, 16);
});

await test('quota: size or "none"', async () => {
  const set = flows.setQuotaFlow(ctx, 'x@a.com');
  await answer((p) => {
    assert.equal(p.fields[0].validate(''), 'Enter a size, or "none" to remove the limit');
    assert.equal(p.fields[0].validate('none'), undefined);
    p.resolve({ quota: '500m' });
  });
  await set;
  assert.deepEqual(calls, [['quota', 'set', 'x@a.com', '500M']]);
  calls.length = 0;
  const none = flows.setQuotaFlow(ctx, 'x@a.com');
  await answer((p) => p.resolve({ quota: 'none' }));
  await none;
  assert.deepEqual(calls, [['quota', 'del', 'x@a.com']]);
});

await test('alias: builds the source address from name and domain', async () => {
  const flow = flows.addAliasFlow(ctx, 'b.org');
  await answer((p) => {
    assert.equal(p.fields[2].validate('nope'), 'Invalid email address');
    p.resolve({ domain: 'b.org', name: 'Support', dest: 'me@example.com' });
  });
  await flow;
  assert.deepEqual(calls, [['alias', 'add', 'support@b.org', 'me@example.com']]);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} flow tests passed`);
process.exit(0);
