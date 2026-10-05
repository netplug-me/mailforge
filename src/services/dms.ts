import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getAppConfig } from '../config.js';
import { DockerService, ExecResult } from './docker.js';
import { MailboxAccount, MailboxAlias } from '../types.js';

export interface ScaffoldOptions {
  primaryDomain?: string;
  mxHost?: string;
  projectDir?: string;
  overwrite?: boolean;
}

export class DmsService {
  private docker: DockerService;
  private projectDir: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir || getAppConfig().projectDir;
    this.docker = new DockerService(this.projectDir);
  }

  /**
   * Scaffolds the complete directory structure and files for Docker Mailserver
   */
  public scaffold(options: ScaffoldOptions = {}): { created: string[]; skipped: string[]; warnings: string[] } {
    const config = getAppConfig(options.projectDir || this.projectDir);
    const primaryDomain = options.primaryDomain || config.primaryDomain;
    const mxHost = options.mxHost || config.mxHost;
    const targetDir = config.projectDir;

    const created: string[] = [];
    const skipped: string[] = [];

    // 1. Create directories
    const dirs = [
      path.join(targetDir, 'docker-data', 'dms', 'mail-data'),
      path.join(targetDir, 'docker-data', 'dms', 'mail-state'),
      path.join(targetDir, 'docker-data', 'dms', 'mail-logs'),
      path.join(targetDir, 'docker-data', 'dms', 'config'),
      path.join(targetDir, 'docker-data', 'dms', 'config', 'opendkim', 'keys'),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(path.relative(targetDir, dir));
      }
    }

    // 2. compose.yaml
    // letsencrypt certs live on the host; DMS can only find them if /etc/letsencrypt is mounted.
    const letsencryptMount = config.sslType === 'letsencrypt'
      ? `\n      - /etc/letsencrypt:/etc/letsencrypt:ro`
      : '';
    const composeContent = `services:
  mailserver:
    image: ghcr.io/docker-mailserver/docker-mailserver:latest
    container_name: mailserver
    hostname: ${mxHost}
    domainname: ${primaryDomain}
    ports:
      - "25:25"
      - "465:465"
      - "587:587"
      - "993:993"
      - "143:143"
    volumes:
      - ./docker-data/dms/mail-data/:/var/mail/
      - ./docker-data/dms/mail-state/:/var/mail-state/
      - ./docker-data/dms/mail-logs/:/var/log/mail/
      - ./docker-data/dms/config/:/tmp/docker-mailserver/
      - /etc/localtime:/etc/localtime:ro${letsencryptMount}
    env_file: ./docker-data/dms/config/mailserver.env
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=UTC
      - ENABLE_CLAMAV=1
      - ENABLE_FAIL2BAN=1
      - ENABLE_SPAMASSASSIN=1
      - ENABLE_RSPAMD=1
      - SSL_TYPE=${config.sslType}
    cap_add:
      - NET_ADMIN
    restart: always
`;

    const composePath = path.join(targetDir, 'compose.yaml');
    if (!fs.existsSync(composePath) || options.overwrite) {
      fs.writeFileSync(composePath, composeContent, 'utf-8');
      created.push('compose.yaml');
    } else {
      skipped.push('compose.yaml');
    }

    // 3. mailserver.env
    const envContent = `# Docker Mailserver Configuration
POSTMASTER_ADDRESS=${config.postmasterAddress}
POSTFIX_VIRTUAL_DOMAINS=''
`;
    const envPath = config.mailserverEnvPath;
    if (!fs.existsSync(envPath) || options.overwrite) {
      fs.writeFileSync(envPath, envContent, 'utf-8');
      created.push(path.relative(targetDir, envPath));
    } else {
      skipped.push(path.relative(targetDir, envPath));
    }

    // 4. .env.example
    const appEnvExample = `# Cloudflare API & Mail Server Config
PRIMARY_DOMAIN=${primaryDomain}
MX_HOST=${mxHost}
DKIM_SELECTOR=mail
CF_API_TOKEN=your_cloudflare_api_token_here
`;
    const appEnvPath = path.join(targetDir, '.env');
    const appEnvExamplePath = path.join(targetDir, '.env.example');
    if (!fs.existsSync(appEnvExamplePath)) {
      fs.writeFileSync(appEnvExamplePath, appEnvExample, 'utf-8');
      created.push('.env.example');
    }
    if (!fs.existsSync(appEnvPath)) {
      fs.writeFileSync(appEnvPath, appEnvExample, 'utf-8');
      created.push('.env');
    }

    // 5. setup.sh helper wrapper
    const setupShPath = path.join(targetDir, 'setup.sh');
    const setupShContent = `#!/usr/bin/env bash
# Upstream DMS setup wrapper
if docker ps --format '{{.Names}}' | grep -q '^mailserver$'; then
  docker exec -i mailserver setup "$@"
else
  docker run --rm -i \\
    -v "\$(pwd)/docker-data/dms/config/:/tmp/docker-mailserver/" \\
    -v "\$(pwd)/docker-data/dms/mail-data/:/var/mail/" \\
    -v "\$(pwd)/docker-data/dms/mail-state/:/var/mail-state/" \\
    -v "\$(pwd)/docker-data/dms/mail-logs/:/var/log/mail/" \\
    ghcr.io/docker-mailserver/docker-mailserver:latest setup "$@"
fi
`;
    if (!fs.existsSync(setupShPath) || options.overwrite) {
      fs.writeFileSync(setupShPath, setupShContent, { mode: 0o755 });
      created.push('setup.sh');
    } else {
      skipped.push('setup.sh');
    }

    const warnings: string[] = [];
    if (config.sslType === 'letsencrypt') {
      const certDir = path.join('/etc/letsencrypt/live', mxHost);
      try {
        fs.statSync(certDir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        warnings.push(
          code === 'EACCES'
            // /etc/letsencrypt/live is root-only; the container (root) can still read it.
            ? `Cannot verify ${certDir}/ as this user (root-only directory); make sure the certificate exists.`
            : `SSL_TYPE=letsencrypt but no certificate at ${certDir}/ - the container will exit on start. ` +
              `Obtain one (e.g. certbot certonly --standalone -d ${mxHost}) or set SSL_TYPE in .env.`
        );
      }
    }

    return { created, skipped, warnings };
  }

  /**
   * Executes a DMS setup command (uses running container or temporary container)
   */
  public runSetup(args: string[]): ExecResult {
    const status = this.docker.getContainerStatus();
    if (status === 'running') {
      const res = spawnSync('docker', ['exec', 'mailserver', 'setup', ...args], {
        cwd: this.projectDir,
        encoding: 'utf-8',
      });
      return {
        code: res.status ?? -1,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        success: res.status === 0,
      };
    }

    // Container not running: run via docker run
    const dockerArgs = [
      'run',
      '--rm',
      '-v',
      `${path.join(this.projectDir, 'docker-data/dms/config')}:/tmp/docker-mailserver/`,
      '-v',
      `${path.join(this.projectDir, 'docker-data/dms/mail-data')}:/var/mail/`,
      '-v',
      `${path.join(this.projectDir, 'docker-data/dms/mail-state')}:/var/mail-state/`,
      '-v',
      `${path.join(this.projectDir, 'docker-data/dms/mail-logs')}:/var/log/mail/`,
      'ghcr.io/docker-mailserver/docker-mailserver:latest',
      'setup',
      ...args,
    ];

    const res = spawnSync('docker', dockerArgs, {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });

    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }

  /**
   * Non-blocking `runSetup` for the TUI. Falls back to the blocking variant when the
   * container is not running (it then starts a throwaway container).
   */
  public async runSetupAsync(args: string[]): Promise<ExecResult> {
    if (this.docker.getContainerStatus() !== 'running') return this.runSetup(args);
    return this.docker.runAsync(['exec', 'mailserver', 'setup', ...args]);
  }

  /**
   * Lists all email accounts configured in DMS
   */
  public listAccounts(): MailboxAccount[] {
    const config = getAppConfig(this.projectDir);
    const accountsFile = path.join(config.configDirPath, 'postfix-accounts.cf');
    if (!fs.existsSync(accountsFile)) {
      return [];
    }
    const content = fs.readFileSync(accountsFile, 'utf-8');
    const lines = content.split(/\r?\n/);
    const accounts: MailboxAccount[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('|');
      const email = parts[0]?.trim();
      if (email && email.includes('@')) {
        const [username, domain] = email.split('@');
        accounts.push({
          email,
          username,
          domain: domain.toLowerCase(),
        });
      }
    }
    return accounts;
  }

  /**
   * Adds an email account
   */
  public addAccount(email: string, password?: string): ExecResult {
    const args = ['email', 'add', email];
    if (password) {
      args.push(password);
    }
    return this.runSetup(args);
  }

  /**
   * Sets a new password on an existing account
   */
  public updateAccount(email: string, password: string): ExecResult {
    return this.runSetup(['email', 'update', email, password]);
  }

  /**
   * Deletes an email account
   */
  public delAccount(email: string): ExecResult {
    return this.runSetup(['email', 'del', email]);
  }

  /**
   * Sets mailbox quota (e.g. "500M", "2G")
   */
  public setQuota(email: string, quota: string): ExecResult {
    return this.runSetup(['quota', 'set', email, quota]);
  }

  /**
   * Lists virtual aliases
   */
  public listAliases(): MailboxAlias[] {
    const config = getAppConfig(this.projectDir);
    const aliasFile = path.join(config.configDirPath, 'postfix-virtual.cf');
    if (!fs.existsSync(aliasFile)) {
      return [];
    }
    const content = fs.readFileSync(aliasFile, 'utf-8');
    const lines = content.split(/\r?\n/);
    const aliases: MailboxAlias[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [src, dst] = trimmed.split(/\s+/);
      if (src && dst) {
        aliases.push({ source: src, destination: dst });
      }
    }
    return aliases;
  }

  /**
   * Adds an alias
   */
  public addAlias(source: string, destination: string): ExecResult {
    return this.runSetup(['alias', 'add', source, destination]);
  }

  /**
   * Deletes an alias
   */
  public delAlias(source: string, destination: string): ExecResult {
    return this.runSetup(['alias', 'del', source, destination]);
  }

  /**
   * Generates DKIM key for a domain
   */
  public generateDkim(domain: string, selector = 'mail', keysize = 2048): ExecResult {
    return this.runSetup(['config', 'dkim', 'selector', selector, 'keysize', keysize.toString(), 'domain', domain]);
  }

  /**
   * Counts mailboxes for a domain from mail-data directory or accounts file
   */
  public countMailboxes(domain: string): number {
    const config = getAppConfig(this.projectDir);
    const accounts = this.listAccounts();
    const fromAccounts = accounts.filter((a) => a.domain.toLowerCase() === domain.toLowerCase()).length;
    if (fromAccounts > 0) return fromAccounts;

    // Fallback: check directories in mail-data/<domain>
    const domainMailDir = path.join(config.mailDataPath, domain);
    if (fs.existsSync(domainMailDir)) {
      try {
        const entries = fs.readdirSync(domainMailDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).length;
      } catch {
        return 0;
      }
    }
    return 0;
  }
}
