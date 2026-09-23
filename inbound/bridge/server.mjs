// inbound-bridge: receives raw email POSTed by the Cloudflare Email Worker (over the
// tunnel) and delivers it to docker-mailserver over SMTP on the Docker network.
// No dependencies; runs on node:22-alpine.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8025);
const SECRET = process.env.BRIDGE_SECRET;
const SMTP_HOST = process.env.SMTP_HOST || 'mailserver';
const SMTP_PORT = Number(process.env.SMTP_PORT || 25);
const HELO = process.env.HELO_NAME || 'inbound-bridge';
const MAX_BYTES = 26 * 1024 * 1024; // Email Routing caps messages at 25 MiB
const MAX_SKEW_S = 300;

if (!SECRET || SECRET.length < 32) {
  console.error('BRIDGE_SECRET must be set (>= 32 chars)');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Signature = HMAC-SHA256(secret, `${timestamp}\n${from}\n${to}\n${sha256(body)}`), hex.
export function sign(secret, ts, from, to, body) {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', secret).update(`${ts}\n${from}\n${to}\n${bodyHash}`).digest('hex');
}

function verify(req, body) {
  const ts = req.headers['x-timestamp'];
  const from = req.headers['x-envelope-from'] ?? '';
  const to = req.headers['x-envelope-to'];
  const sig = req.headers['x-signature'];
  if (!ts || !to || !sig) return 'missing headers';
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) return 'stale timestamp';
  const want = Buffer.from(sign(SECRET, ts, from, to, body), 'hex');
  const got = Buffer.from(String(sig), 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'bad signature';
  return null;
}

const ADDR = /^[^\s<>"]*$/; // envelope addresses go into SMTP commands; no CR/LF/spaces/brackets

// Minimal SMTP client: EHLO, MAIL, RCPT, DATA. Resolves with the final reply
// {code, text}; never throws for SMTP-level rejections.
function smtpDeliver(from, to, raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SMTP_PORT, SMTP_HOST);
    sock.setTimeout(60_000, () => sock.destroy(new Error('smtp timeout')));
    let buf = '';
    // Each step: the reply code we expect, then what to send once we get it.
    const body = () => {
      // Normalise to CRLF and dot-stuff lines starting with '.'
      let s = raw.toString('latin1').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
      if (!s.endsWith('\r\n')) s += '\r\n';
      return Buffer.from(s + '.\r\n', 'latin1');
    };
    const steps = [
      { expect: 220, send: () => `EHLO ${HELO}\r\n` },       // greeting
      { expect: 250, send: () => `MAIL FROM:<${from}>\r\n` }, // EHLO ok
      { expect: 250, send: () => `RCPT TO:<${to}>\r\n` },     // MAIL ok
      { expect: 250, send: () => 'DATA\r\n' },                // RCPT ok
      { expect: 354, send: body },                            // go ahead
      { expect: 250, final: true },                           // message accepted
    ];
    let i = 0;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
      sock.end('QUIT\r\n');
    };
    sock.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    sock.on('close', () => { if (!settled) { settled = true; reject(new Error('smtp connection closed')); } });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      // A complete reply ends with a line "NNN text" (space, not '-', after the code);
      // multi-line replies ("250-...") are consumed along with it.
      let m;
      while (!settled && (m = buf.match(/^(\d{3}) ([^\r\n]*)\r?\n/m))) {
        const end = buf.indexOf(m[0]) + m[0].length;
        const code = Number(m[1]);
        const text = buf.slice(0, end).trim();
        buf = buf.slice(end);
        const step = steps[i++];
        if (code !== step.expect || step.final) return done({ code, text });
        sock.write(step.send());
      }
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/ingest') {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BYTES) { res.writeHead(413).end('too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (res.writableEnded) return;
    const body = Buffer.concat(chunks);
    const err = verify(req, body);
    if (err) {
      log('reject', err, req.headers['x-envelope-to']);
      res.writeHead(401).end(err);
      return;
    }
    const from = String(req.headers['x-envelope-from'] ?? '');
    const to = String(req.headers['x-envelope-to']);
    if (!ADDR.test(from) || !ADDR.test(to)) {
      res.writeHead(400).end('bad envelope address');
      return;
    }
    try {
      const r = await smtpDeliver(from, to, body);
      log('smtp', r.code, `from=<${from}> to=<${to}> bytes=${body.length}`);
      // Pass SMTP class through: 2xx delivered, 4xx retry later, 5xx permanent.
      const status = r.code >= 200 && r.code < 300 ? 200 : r.code >= 500 ? 422 : 503;
      res.writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ smtpCode: r.code, smtpText: r.text }));
    } catch (e) {
      log('smtp error', e.message);
      res.writeHead(503).end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => log(`inbound-bridge listening on :${PORT}, delivering to ${SMTP_HOST}:${SMTP_PORT}`));
