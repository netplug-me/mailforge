import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { AppConfig } from './types.js';

// Load .env from cwd or project root
dotenv.config();

let cachedConfig: AppConfig | null = null;

export function getAppConfig(customProjectDir?: string): AppConfig {
  if (cachedConfig && !customProjectDir) {
    return cachedConfig;
  }

  const projectDir = customProjectDir || process.env.DMS_PROJECT_DIR || process.cwd();
  
  // Also try loading .env from projectDir if not loaded
  const envPath = path.join(projectDir, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }

  const primaryDomain = (process.env.PRIMARY_DOMAIN || 'example.com').trim().toLowerCase();
  const mxHost = (process.env.MX_HOST || `mail.${primaryDomain}`).trim().toLowerCase();
  const dkimSelector = (process.env.DKIM_SELECTOR || 'mail').trim();
  const postmasterAddress = process.env.POSTMASTER_ADDRESS || `postmaster@${primaryDomain}`;
  const cloudflareApiToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || undefined;
  // docker-mailserver SSL_TYPE: letsencrypt | manual | self-signed | '' (no TLS; local testing only)
  const sslType = (process.env.SSL_TYPE ?? 'letsencrypt').trim();

  const hiddenZones = (process.env.TUI_HIDE_ZONES || '')
    .split(/[\s,]+/)
    .map((z) => z.trim().toLowerCase())
    .filter(Boolean);

  const config: AppConfig = {
    primaryDomain,
    mxHost,
    dkimSelector,
    projectDir,
    composeFilePath: path.join(projectDir, 'compose.yaml'),
    mailserverEnvPath: path.join(projectDir, 'docker-data', 'dms', 'config', 'mailserver.env'),
    mailDataPath: path.join(projectDir, 'docker-data', 'dms', 'mail-data'),
    configDirPath: path.join(projectDir, 'docker-data', 'dms', 'config'),
    opendkimKeysPath: path.join(projectDir, 'docker-data', 'dms', 'config', 'opendkim', 'keys'),
    rspamdDkimPath: path.join(projectDir, 'docker-data', 'dms', 'config', 'rspamd', 'dkim'),
    cloudflareApiToken,
    postmasterAddress,
    sslType,
    hiddenZones,
  };

  if (!customProjectDir) {
    cachedConfig = config;
  }
  return config;
}

export function saveAppEnv(updates: Partial<Record<string, string>>, targetDir?: string): void {
  const projectDir = targetDir || process.cwd();
  const envPath = path.join(projectDir, '.env');
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const k = trimmed.substring(0, eqIdx).trim();
      if (k === key) {
        lines[i] = `${key}=${value}`;
        found = true;
        break;
      }
    }
    if (!found) {
      lines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
  clearConfigCache();
}

/** Explicitly clear the cached AppConfig. Used after .env changes. */
export function clearConfigCache(): void {
  cachedConfig = null;
}
