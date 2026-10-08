#!/usr/bin/env python3
"""Zero Trust side of the AWS proxy box (see README.md §1). Idempotent; --dry-run prints the plan.

Creates only new, separately named objects and never edits existing ones:
  1. service token "mail-proxy-warp" (its secret goes straight into aws-proxy/mdm.xml, mode 600, gitignored)
  2. a Service Auth policy for that token on the "Warp Login App" (device enrolment)
  3. a custom device profile matched to service-token devices, Split Tunnels = Include 172.25.0.10/32
  4. Gateway TCP proxy on (org-wide setting; network policies can't see WARP traffic without it)
  5. Gateway network policies for 172.25.0.10: allow the mail ports, block everything else

Usage (from the project dir that holds .env):  python3 aws-proxy/setup_zero_trust.py [--dry-run]
Needs token permissions: Access Service Tokens Write, Access Apps and Policies Write,
Zero Trust Write (device profiles, Gateway).
"""
import json, os, sys, urllib.request, urllib.error

DRY = '--dry-run' in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
API = 'https://api.cloudflare.com/client/v4'
MAIL_IP = '172.25.0.10'
TOKEN_NAME = 'mail-proxy-warp'
POLICY_NAME = 'mail-proxy-service-auth'
PROFILE_NAME = 'mail-proxy (service token)'
# The mailserver's PROXY-protocol ports (aws-proxy/dms/). Plain 993/465/587 stay closed to WARP: the proxy box no longer uses them.
PORTS = '10993 10465 10587'
MDM_PATH = os.path.join(HERE, 'mdm.xml')

env = {}
for line in open(os.path.join(os.getcwd(), '.env')):
    if '=' in line and not line.lstrip().startswith('#'):
        k, v = line.strip().split('=', 1)
        env[k.strip()] = v.strip()


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': f'Bearer {env["CF_API_TOKEN"]}', 'Content-Type': 'application/json'})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        d = json.load(e)
    if not d.get('success'):
        raise SystemExit(f'{method} {path} failed: {[(x.get("code"), x.get("message")) for x in d.get("errors", [])]}')
    return d.get('result')


def step(msg):
    print(('[dry-run] ' if DRY else '') + msg)


ACCT = call('GET', f'/zones?name={env["PRIMARY_DOMAIN"]}')[0]['account']['id']
P = f'/accounts/{ACCT}'
AUTH_DOMAIN = call('GET', f'{P}/access/organizations')['auth_domain']
TEAM = AUTH_DOMAIN.split('.')[0]

# 1. service token
token = next((t for t in call('GET', f'{P}/access/service_tokens') if t['name'] == TOKEN_NAME), None)
if token:
    print(f'service token {TOKEN_NAME} exists ({token["id"]})')
    if not os.path.exists(MDM_PATH):
        print(f'  note: its secret was shown once at creation; {MDM_PATH} is absent. Rotate the token in the dashboard or delete it and re-run.')
else:
    step(f'create service token {TOKEN_NAME} (5 years) and write {MDM_PATH}')
    if not DRY:
        token = call('POST', f'{P}/access/service_tokens', {'name': TOKEN_NAME, 'duration': '43800h'})
        xml = f'''<dict>
  <key>organization</key>
  <string>{TEAM}</string>
  <key>auth_client_id</key>
  <string>{token['client_id']}</string>
  <key>auth_client_secret</key>
  <string>{token['client_secret']}</string>
  <key>service_mode</key>
  <string>warp</string>
  <key>auto_connect</key>
  <integer>0</integer>
  <key>onboarding</key>
  <false/>
</dict>
'''
        fd = os.open(MDM_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(xml)
        print(f'wrote {MDM_PATH} (mode 600; the secret is not printed)')

# 2. enrolment policy on the Warp Login App
warp_app = next(a for a in call('GET', f'{P}/access/apps') if a['type'] == 'warp')
policies = call('GET', f'{P}/access/apps/{warp_app["id"]}/policies')
if any(p['name'] == POLICY_NAME for p in policies):
    print(f'enrolment policy {POLICY_NAME} exists')
else:
    step(f'add Service Auth policy {POLICY_NAME} for {TOKEN_NAME} to "{warp_app["name"]}"')
    if not DRY:
        call('POST', f'{P}/access/apps/{warp_app["id"]}/policies',
             {'name': POLICY_NAME, 'decision': 'non_identity', 'include': [{'service_token': {'token_id': token['id']}}],
              'precedence': max([p.get('precedence') or 0 for p in policies]) + 1})

# 3. device profile for the service-token identity: Include mode, only the mailserver
match = f'identity.email == "non_identity@{AUTH_DOMAIN}"'
profiles = call('GET', f'{P}/devices/policies')
if any(p.get('name') == PROFILE_NAME for p in profiles):
    print(f'device profile "{PROFILE_NAME}" exists')
else:
    step(f'create device profile "{PROFILE_NAME}" match {match}, Include {MAIL_IP}/32')
    if not DRY:
        call('POST', f'{P}/devices/policy', {
            'name': PROFILE_NAME, 'description': 'AWS mail proxy: route only the mailserver through WARP',
            'match': match, 'precedence': 500, 'enabled': True,
            'service_mode_v2': {'mode': 'warp'}, 'auto_connect': 0, 'switch_locked': False,
            'include': [{'address': f'{MAIL_IP}/32', 'description': 'mailserver (IMAPS/submission)'}]})

# 4. Gateway TCP proxy
settings = call('GET', f'{P}/devices/settings')
if settings.get('gateway_proxy_enabled'):
    print('Gateway TCP proxy already on')
else:
    step('enable Gateway TCP proxy (org-wide)')
    if not DRY:
        call('PATCH', f'{P}/devices/settings', {'gateway_proxy_enabled': True})

# 5. Gateway network policies
rules = {r['name']: r for r in call('GET', f'{P}/gateway/rules')}
wanted = [
    ('mail-proxy: allow mail ports', 'allow', f'net.dst.ip == {MAIL_IP} and net.dst.port in {{{PORTS}}}', 10010),
    ('mail-proxy: block rest', 'block', f'net.dst.ip == {MAIL_IP}', 10020),
]
for name, action, traffic, prec in wanted:
    if name in rules:
        if rules[name]['traffic'] == traffic:
            print(f'gateway rule "{name}" exists')
        else:
            step(f'update gateway rule "{name}": {traffic}')
            if not DRY:
                r = rules[name]
                call('PUT', f'{P}/gateway/rules/{r["id"]}', {'name': name, 'action': r['action'], 'enabled': r['enabled'],
                     'filters': r['filters'], 'traffic': traffic, 'precedence': r['precedence'],
                     'description': r.get('description', '')})
        continue
    step(f'create gateway rule "{name}": {action} when {traffic}')
    if not DRY:
        call('POST', f'{P}/gateway/rules', {'name': name, 'action': action, 'enabled': True, 'filters': ['l4'],
                                           'traffic': traffic, 'precedence': prec, 'description': 'aws-proxy/ runbook'})
