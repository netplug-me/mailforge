// Unit tests for TXT-record target selection in CloudflareService.upsertRecord.
// Regression: upsertRecord used to take existingList[0] for any TXT record, so
// syncing SPF at the apex could clobber an unrelated TXT record (e.g. a
// site-verification record) that happened to sort first.
// Run after `npm run build`: npm run test:unit
import assert from 'node:assert/strict';
import { selectTxtTarget, txtLeadingTag, normalizeTxtContent } from '../dist/services/cloudflare.js';

const rec = (id, content) => ({ id, type: 'TXT', name: 'example.com', content });

// 1. The original bug: SPF sync must NOT clobber an unrelated TXT at the apex.
{
  const existing = [rec('site-verify', 'google-site-verification=abc123')];
  const desired = rec('new', 'v=spf1 mx ~all');
  assert.equal(selectTxtTarget(existing, desired), undefined, 'no tag match → create, never clobber');
}

// 2. Tag match wins even when the unrelated record sorts first in the list.
{
  const existing = [
    rec('site-verify', 'google-site-verification=abc123'),
    rec('spf', 'v=spf1 include:_spf.mx.cloudflare.net mx ~all'),
  ];
  const desired = rec('new', 'v=spf1 mx ~all');
  assert.equal(selectTxtTarget(existing, desired)?.id, 'spf', 'updates the SPF record, not the verification record');
}

// 3. DKIM key rotation: updates the existing key; Cloudflare-quoted content still matches.
{
  const existing = [rec('dkim', '"v=DKIM1; k=rsa; p=OLDKEY"')];
  const desired = rec('new', 'v=DKIM1; k=rsa; p=NEWKEY');
  assert.equal(selectTxtTarget(existing, desired)?.id, 'dkim');
}

// 4. DMARC version tag is case-insensitive (v=DMARC1 vs v=dmarc1).
{
  const existing = [rec('dmarc', 'v=DMARC1; p=none;')];
  const desired = rec('new', 'v=dmarc1; p=none;');
  assert.equal(selectTxtTarget(existing, desired)?.id, 'dmarc');
}

// 5. Duplicate records with the same tag → prefer the one whose content already matches.
{
  const existing = [rec('a', 'v=spf1 mx ~all'), rec('b', 'v=spf1 include:other ~all')];
  const desired = rec('new', 'v=spf1 include:other ~all');
  assert.equal(selectTxtTarget(existing, desired)?.id, 'b');
}

// 6. Duplicates with no exact content match → first candidate (deterministic).
{
  const existing = [rec('a', 'v=spf1 mx ~all'), rec('b', 'v=spf1 include:other ~all')];
  const desired = rec('new', 'v=spf1 ~all');
  assert.equal(selectTxtTarget(existing, desired)?.id, 'a');
}

// 7. Tag extraction basics.
assert.equal(txtLeadingTag('v=spf1 mx ~all'), 'v=spf1');
assert.equal(txtLeadingTag('v=DMARC1; p=none;'), 'v=dmarc1');
assert.equal(txtLeadingTag('"v=DKIM1; k=rsa; p=abc"'), 'v=dkim1');
assert.equal(txtLeadingTag('google-site-verification=abc'), 'google-site-verification=abc');
assert.equal(normalizeTxtContent('"v=spf1 mx ~all"'), 'v=spf1 mx ~all');

console.log('txt-upsert: all assertions passed');
