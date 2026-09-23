// Cloudflare Email Worker: forwards each inbound message, unmodified, to the
// inbound-bridge over the Cloudflare Tunnel. Bindings:
//   BRIDGE_URL    (plain var)  e.g. https://mail-ingest.switchboard.llc/ingest
//   BRIDGE_SECRET (secret)     shared HMAC key, same value as the bridge's BRIDGE_SECRET

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Must match sign() in bridge/server.mjs:
// HMAC-SHA256(secret, `${ts}\n${from}\n${to}\n${sha256hex(body)}`)
async function sign(secret, ts, from, to, body) {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', body));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}\n${from}\n${to}\n${bodyHash}`)));
}

export default {
  async email(message, env) {
    const body = await new Response(message.raw).arrayBuffer();
    const ts = Math.floor(Date.now() / 1000).toString();
    const from = message.from ?? '';
    const to = message.to;

    const res = await fetch(env.BRIDGE_URL, {
      method: 'POST',
      body,
      headers: {
        'content-type': 'message/rfc822',
        'x-timestamp': ts,
        'x-envelope-from': from,
        'x-envelope-to': to,
        'x-signature': await sign(env.BRIDGE_SECRET, ts, from, to, body),
      },
    });

    if (res.ok) return; // delivered to docker-mailserver

    const detail = (await res.text()).slice(0, 300);
    if (res.status === 422) {
      // Mail server permanently rejected it (e.g. unknown mailbox): bounce to sender.
      let text = detail;
      try { text = JSON.parse(detail).smtpText || detail; } catch {}
      message.setReject(text);
      return;
    }
    // Anything else (bridge/tunnel down, 4xx from the mail server): fail the
    // invocation so it is not silently accepted and dropped.
    throw new Error(`bridge returned ${res.status}: ${detail}`);
  },
};
