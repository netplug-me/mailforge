#!/usr/bin/env python3
"""Set up the Cloudflare side of inbound mail for PRIMARY_DOMAIN. Idempotent.

  1. Tunnel "<domain>-inbound" with ingress  mail-ingest.<domain> -> http://inbound-bridge:8025
  2. Proxied CNAME  mail-ingest.<domain> -> <tunnel-id>.cfargotunnel.com
  3. Email Worker "<domain>-inbound" (worker/worker.js) with BRIDGE_URL and BRIDGE_SECRET
  4. Email Routing enabled, with a catch-all rule sending every address to the Worker.
     Email Routing needs its own MX/SPF records, so a conflicting MX record and the
     domain's SPF TXT record are replaced (both are printed before anything changes).
  5. Writes the tunnel connector token into .env as CF_TUNNEL_TOKEN.

Usage (from the project dir that holds .env):  python3 inbound/setup_cloudflare.py [--dry-run]
Needs token permissions: Zone DNS Edit, Zone Email Routing Rules Edit,
Account Workers Scripts Edit, Account Cloudflare Tunnel Edit.
"""
import json, os, re, sys, urllib.request, urllib.error, uuid

DRY = '--dry-run' in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.getcwd()
API = 'https://api.cloudflare.com/client/v4'


def load_env(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def set_env_value(path, key, value):
    lines = open(path).read().splitlines()
    for i, line in enumerate(lines):
        if line.split('=', 1)[0].strip() == key:
            lines[i] = f'{key}={value}'
            break
    else:
        lines.append(f'{key}={value}')
    with open(path, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    os.chmod(path, 0o600)


ENV_PATH = os.path.join(PROJECT, '.env')
env = load_env(ENV_PATH)
TOKEN = env.get('CF_API_TOKEN')
DOMAIN = env.get('PRIMARY_DOMAIN')
SECRET = env.get('BRIDGE_SECRET')
if not (TOKEN and DOMAIN and SECRET):
    sys.exit('.env must define CF_API_TOKEN, PRIMARY_DOMAIN and BRIDGE_SECRET')

NAME = f"{DOMAIN.replace('.', '-')}-inbound"
INGEST_HOST = f'mail-ingest.{DOMAIN}'
BRIDGE_URL = f'https://{INGEST_HOST}/ingest'
CF_MX_SPF = 'include:_spf.mx.cloudflare.net'


def call(method, path, body=None, raw=None, ctype='application/json'):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(API + path, method=method, data=data,
                                 headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': ctype})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        try:
            d = json.load(e)
        except Exception:
            d = {'success': False, 'errors': [{'code': e.code, 'message': e.reason}]}
    if not d.get('success'):
        errs = [(e.get('code'), e.get('message')) for e in d.get('errors', [])]
        raise SystemExit(f'Cloudflare API {method} {path} failed: {errs}')
    return d.get('result')


def step(msg):
    print(('[dry-run] ' if DRY else '') + msg)


zone = call('GET', f'/zones?name={DOMAIN}')
if not zone:
    sys.exit(f'zone {DOMAIN} not found for this token')
ZID, ACCT = zone[0]['id'], zone[0]['account']['id']

# 1. Tunnel
tunnels = call('GET', f'/accounts/{ACCT}/cfd_tunnel?name={NAME}&is_deleted=false')
if tunnels:
    tid = tunnels[0]['id']
    print(f'tunnel {NAME} exists ({tid})')
else:
    step(f'create tunnel {NAME}')
    tid = None if DRY else call('POST', f'/accounts/{ACCT}/cfd_tunnel', {'name': NAME, 'config_src': 'cloudflare'})['id']
ingress = {'config': {'ingress': [
    {'hostname': INGEST_HOST, 'service': 'http://inbound-bridge:8025'},
    {'service': 'http_status:404'},
]}}
step(f'set tunnel ingress {INGEST_HOST} -> http://inbound-bridge:8025')
if not DRY:
    call('PUT', f'/accounts/{ACCT}/cfd_tunnel/{tid}/configurations', ingress)

# 2. DNS for the ingest hostname
target = f'{tid}.cfargotunnel.com' if tid else '<tunnel-id>.cfargotunnel.com'
existing = call('GET', f'/zones/{ZID}/dns_records?name={INGEST_HOST}')
if existing and existing[0]['type'] == 'CNAME' and existing[0]['content'] == target:
    print(f'DNS {INGEST_HOST} already points to the tunnel')
else:
    for r in existing:
        step(f"delete DNS {r['type']} {r['name']} -> {r['content']}")
        if not DRY:
            call('DELETE', f"/zones/{ZID}/dns_records/{r['id']}")
    step(f'create DNS CNAME {INGEST_HOST} -> {target} (proxied)')
    if not DRY:
        call('POST', f'/zones/{ZID}/dns_records', {'type': 'CNAME', 'name': INGEST_HOST, 'content': target, 'proxied': True})

# 3. Worker
src = open(os.path.join(HERE, 'worker', 'worker.js'), 'rb').read()
meta = {'main_module': 'worker.js', 'compatibility_date': '2025-01-01',
        'bindings': [{'type': 'plain_text', 'name': 'BRIDGE_URL', 'text': BRIDGE_URL}]}
b = uuid.uuid4().hex
multipart = (f'--{b}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n'
             f'Content-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n'
             f'--{b}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
             f'Content-Type: application/javascript+module\r\n\r\n').encode() + src + f'\r\n--{b}--\r\n'.encode()
step(f'upload Worker {NAME} (BRIDGE_URL={BRIDGE_URL})')
if not DRY:
    call('PUT', f'/accounts/{ACCT}/workers/scripts/{NAME}', raw=multipart, ctype=f'multipart/form-data; boundary={b}')
    call('PUT', f'/accounts/{ACCT}/workers/scripts/{NAME}/secrets',
         {'name': 'BRIDGE_SECRET', 'text': SECRET, 'type': 'secret_text'})
    print('Worker secret BRIDGE_SECRET set')

# 4. Email Routing
records = call('GET', f'/zones/{ZID}/dns_records?per_page=100')
for r in records:
    if r['type'] == 'MX' and r['name'] == DOMAIN and not r['content'].endswith('.mx.cloudflare.net'):
        step(f"delete conflicting MX {r['name']} -> {r['content']}")
        if not DRY:
            call('DELETE', f"/zones/{ZID}/dns_records/{r['id']}")
for r in records:
    if r['type'] == 'TXT' and r['name'] == DOMAIN and r['content'].strip('"').startswith('v=spf1') and CF_MX_SPF not in r['content']:
        new = re.sub(r'\s+', ' ', r['content'].strip('"').replace('v=spf1', f'v=spf1 {CF_MX_SPF}', 1))
        step(f"update SPF '{r['content']}' -> '{new}'")
        if not DRY:
            call('PATCH', f"/zones/{ZID}/dns_records/{r['id']}", {'content': new})
status = call('GET', f'/zones/{ZID}/email/routing')
if status.get('enabled'):
    print('Email Routing already enabled')
else:
    step('enable Email Routing (Cloudflare adds its MX records)')
    if not DRY:
        call('POST', f'/zones/{ZID}/email/routing/enable', {})
step(f'catch-all: all addresses @{DOMAIN} -> Worker {NAME}')
if not DRY:
    call('PUT', f'/zones/{ZID}/email/routing/rules/catch_all',
         {'enabled': True, 'matchers': [{'type': 'all'}], 'actions': [{'type': 'worker', 'value': [NAME]}]})

# 5. Connector token
if not DRY:
    tok = call('GET', f'/accounts/{ACCT}/cfd_tunnel/{tid}/token')
    set_env_value(ENV_PATH, 'CF_TUNNEL_TOKEN', tok)
    print('CF_TUNNEL_TOKEN written to .env')
    print('\nNext: docker compose -f compose.yaml -f inbound/compose.inbound.yaml up -d')
