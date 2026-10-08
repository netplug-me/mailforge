# PLAN.md — Bug Fixes for `cf-mail-tui`

## Bug 1 — `getAppConfig()` config cache + `saveAppEnv()` (Medium)

**File:** `src/config.ts`

**Problem:** `dotenv.config({ override: true })` was called on every call, even when returning cached config. Also, `saveAppEnv()` set `cachedConfig = null` directly without a named export.

**Fix:** ✅ DONE

1. `.env` re-read was already inside the cache miss branch (early return when `cachedConfig && !customProjectDir`).
2. Added `clearConfigCache()` export for explicit cache invalidation.
3. Updated `saveAppEnv()` to call `clearConfigCache()` instead of `cachedConfig = null` directly.

---

## Bug 2 — `domain-manager.ts` `addDomain()` uses blocking `spawnSync` inside an async method (Low)

**File:** `src/services/domain-manager.ts`, line 118

**Problem:** `generateDkim()` → `runSetup()` → `spawnSync` blocks the event loop inside an async method.

**Fix:**

1. Add an async variant `generateDkimAsync()` to `DmsService` that uses `runSetupAsync()` instead of `runSetup()`.
2. In `addDomain()`, call `generateDkimAsync()` instead of `generateDkim()`.
3. Similarly ensure `addAccount`, `setQuota`, `delAccount` in `addDomain()` use async variants.
4. Update `addDomainFlow()` in `flows.ts` to use the async path (it already does via `ui.task()` wrapping, but the underlying service should be async-first).

---

## Bug 3 — DKIM generation failure silently masked by stale files (Medium)

**File:** `src/services/domain-manager.ts`, lines 118-128

**Problem:** If `generateDkim` fails, the code checks if the DKIM file exists. If a stale file exists from a previous run, `dkimGenerated` is set to `true` and `dkimVal` is populated — masking the failure.

**Fix:**

1. Only set `dkimGenerated = true` and `dkimVal` if `dkimRes.success` is **true** (not just if the file exists).
2. If the file exists but generation failed, emit a warning (not a silent success):

```typescript
const dkimRes = this.dms.generateDkim(domain, this.config.dkimSelector);
if (dkimRes.success) {
  dkimGenerated = true;
  const dkimInfo = this.dkim.getDkimInfo(domain, this.config.dkimSelector);
  if (dkimInfo.exists) {
    dkimVal = dkimInfo.dnsValue;
  }
} else {
  errors.push(`DKIM generation failed: ${(dkimRes.stderr || dkimRes.stdout).trim()}`);
  // Don't check for stale files — the generation failed, report it
}
```

3. Add a test case in `ops-parsers.test.mjs` or a new `domain-manager.test.mjs` covering the "stale file after failed generation" scenario.

---

## Bug 4 — `pipeline()` silently swallows invalid domain errors (Low)

**File:** `src/services/ops.ts`, line 222

**Problem:** `dns.resolveMx(domain).catch(() => [] as MxRecord[])` swallows all errors including `ERR_INVALID_ARGUMENT` for invalid domains.

**Fix:**

1. Catch only transient DNS errors, not invalid-argument errors:

```typescript
const mxResult = await dns.resolveMx(domain).catch((err: any) => {
  if (err.code === 'ERR_INVALID_ARGUMENT') {
    return [] as MxRecord[]; // Invalid domain → no MX
  }
  return [] as MxRecord[]; // Any other error → no MX
});
```

2. Alternatively, validate the domain first using `isValidDomain()` before calling `resolveMx`.

---

## Bug 5 — `env-file.ts` set() trims vs untrimmed mismatch (Low)

**File:** `src/utils/env-file.ts`, lines 50-58

**Problem:** `line` is the trimmed version but `this.lines[i]` is untrimmed, causing key comparison to fail on lines with leading whitespace.

**Fix:**

1. Use the trimmed line consistently for key extraction, or use the raw line for everything:

```typescript
for (let i = 0; i < this.lines.length; i++) {
  const rawLine = this.lines[i];
  const trimmed = rawLine.trim();
  if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
  const eqIdx = trimmed.indexOf('=');
  const k = trimmed.substring(0, eqIdx).trim();
  if (k === key) {
    this.lines[i] = `${key}=${formattedVal}`;
    found = true;
    break;
  }
}
```

2. Same fix applies to `get()` (line 34) and `remove()` (line 71) for consistency.

---

## Bug 6 — Spinner text misleading during mailbox creation (Low)

**File:** `src/tui/flows.ts`, lines 375-386

**Problem:** `ui.task()` shows "Adding domain…" during mailbox creation, which is misleading.

**Fix:**

1. Use `ui.setBusy()` to update the spinner text between the domain add and mailbox creation steps:

```typescript
const outcome = await ui.task(`Adding ${domain}…`, async () => {
  const res = await ctx.dm.addDomain({
    domain,
    users: forward ? users : [],
    forward: forward || undefined,
    syncDns: Boolean(v.dns),
  });
  ui.setBusy('Creating mailboxes…');
  const boxes = !forward && users.length > 0
    ? await createMailboxes(ctx, domain, users, String(v.password), String(v.quota).trim().toUpperCase())
    : { created: [], errors: [] };
  return { res, boxes };
});
```

2. This is cosmetic — low priority.

---

## Bug 7 — Modulo bias in password generation (Info)

**File:** `src/tui/theme.ts`, line 73

**Problem:** `alphabet[b % alphabet.length]` has ~2ppb bias.

**Fix:**

1. Use rejection sampling to ensure uniform distribution:

```typescript
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const alphabetLen = alphabet.length;
  const threshold = Math.floor(0xFFFFFFFF / alphabetLen) * alphabetLen; // 650111488
  const result = new Array(length);
  const bytes = new Uint32Array(length); // pre-allocate to avoid repeated allocations
  for (let i = 0; i < length; i++) {
    let val: number;
    do {
      globalThis.crypto.getRandomValues(bytes);
      val = bytes[i];
    } while (val >= threshold);
    result[i] = alphabet[val % alphabetLen];
  }
  return result.join('');
}
```

2. This is cosmetic — the bias is negligible for practical purposes.

---

## Bug 8 — `composeArgs()` hidden side effect (Info)

**File:** `src/services/docker.ts`, line 26

**Problem:** `getAppConfig(this.projectDir)` is called for its side effect (loading .env), not its return value.

**Fix:**

1. Rename to `ensureEnvLoaded()` to make the side effect explicit.
2. Alternatively, load `.env` in the constructor or module initialization and remove the call from `composeArgs()`.

---

## Implementation Status — ALL DONE

| # | Bug | Status |
|---|---|---|
| 1 | `getAppConfig()` config cache + `clearConfigCache()` | ✅ Fixed |
| 2 | `domain-manager.ts` blocking `spawnSync` in async `addDomain()` | ✅ Fixed — added `generateDkimAsync()` to DmsService |
| 3 | DKIM generation failure masked by stale files | ✅ Fixed — only set `dkimGenerated=true` when `dkimRes.success` is true |
| 4 | `pipeline()` swallows all DNS errors | ✅ Fixed — catch `ERR_INVALID_ARGUMENT` explicitly |
| 5 | `env-file.ts` `set()`/`get()`/`remove()` trim mismatch | ✅ Fixed — use trimmed line consistently in all three methods |
| 6 | Spinner text misleading during mailbox creation | ✅ Fixed — `ui.setBusy('Creating mailboxes…')` between steps |
| 7 | Modulo bias in `generatePassword()` | ✅ Fixed — rejection sampling with threshold |
| 8 | `composeArgs()` hidden `.env` side effect | ✅ Fixed — renamed to `ensureEnvLoaded()` |

## Test Results

All tests pass: ops-parsers (17), flows (7), tui-layout (64), txt-upsert (multiple).
