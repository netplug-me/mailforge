import fs from 'node:fs';
import path from 'node:path';
import { getAppConfig } from '../config.js';
import { EnvFileManager } from '../utils/env-file.js';
import { isValidDomain, normalizeDomain } from '../utils/validator.js';
import type { ExecResult } from './docker.js';
import { DmsService } from './dms.js';
import { DkimService } from './dkim.js';
import { DnsCheckerService } from './dns.js';
import { CloudflareService } from './cloudflare.js';
import { AddDomainOptions, RemoveDomainOptions, DomainInfo, DomainDnsStatus } from '../types.js';

export class DomainManager {
  private config = getAppConfig();
  private envManager: EnvFileManager;
  private dms: DmsService;
  private dkim: DkimService;
  private dnsChecker: DnsCheckerService;
  private cf: CloudflareService;

  constructor(projectDir?: string) {
    if (projectDir) {
      this.config = getAppConfig(projectDir);
    }
    this.envManager = new EnvFileManager(this.config.mailserverEnvPath);
    this.dms = new DmsService(this.config.projectDir);
    this.dkim = new DkimService(this.config.projectDir);
    this.dnsChecker = new DnsCheckerService();
    this.cf = new CloudflareService(this.config.cloudflareApiToken);
  }

  /**
   * Retrieves all registered domains (primary + virtual domains)
   */
  public getAllDomains(): string[] {
    this.envManager.load();
    const virtualDomains = this.envManager.getVirtualDomains();
    const all = [this.config.primaryDomain, ...virtualDomains];
    return Array.from(new Set(all.map((d) => normalizeDomain(d))));
  }

  /**
   * Retrieves domain details including mailbox count, DKIM status, and live DNS
   */
  public async getDomainDetails(domain: string, checkLiveDns = true): Promise<DomainInfo> {
    const norm = normalizeDomain(domain);
    const isPrimary = norm === normalizeDomain(this.config.primaryDomain);
    const mailboxCount = this.dms.countMailboxes(norm);
    const dkimInfo = this.dkim.getDkimInfo(norm, this.config.dkimSelector);

    let dnsStatus: DomainDnsStatus = {
      mx: { status: 'unknown', records: [] },
      spf: { status: 'unknown', records: [] },
      dkim: { status: 'unknown', records: [] },
      dmarc: { status: 'unknown', records: [] },
    };

    if (checkLiveDns) {
      dnsStatus = await this.dnsChecker.checkAll(norm, this.config.mxHost, this.config.dkimSelector);
    }

    return {
      domain: norm,
      isPrimary,
      mailboxCount,
      dkimExists: dkimInfo.exists,
      dkimSelector: this.config.dkimSelector,
      dkimRecordValue: dkimInfo.dnsValue,
      dnsStatus,
    };
  }

  /**
   * Lists all domains with their statuses
   */
  public async listDomains(checkLiveDns = true): Promise<DomainInfo[]> {
    const domains = this.getAllDomains();
    const results = await Promise.all(domains.map((d) => this.getDomainDetails(d, checkLiveDns)));
    return results;
  }

  /**
   * Adds a virtual domain to Docker Mailserver and optionally configures Cloudflare DNS
   */
  public async addDomain(options: AddDomainOptions): Promise<{
    domain: string;
    dkimGenerated: boolean;
    dkimValue?: string;
    dnsSyncResult?: any;
    accountsAdded: string[];
    aliasesAdded: string[];
    errors: string[];
  }> {
    const domain = normalizeDomain(options.domain);
    const errors: string[] = [];

    if (!isValidDomain(domain)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }

    if (domain === normalizeDomain(this.config.primaryDomain)) {
      throw new Error(`Domain ${domain} is already the primary domain.`);
    }

    const currentDomains = this.envManager.getVirtualDomains();
    if (currentDomains.includes(domain)) {
      throw new Error(`Domain ${domain} is already registered in mailserver.env`);
    }

    // 1. Register the domain in mailserver.env. docker-mailserver never reads this variable
    // (Postfix derives its domain list from the mailboxes/aliases), so no container
    // recreate is needed; this list only tells the TUI which domains it manages.
    this.envManager.addVirtualDomain(domain);

    // 2. Generate DKIM key
    let dkimGenerated = false;
    let dkimVal: string | undefined;
    const dkimRes = await this.dms.generateDkimAsync(domain, this.config.dkimSelector);
    if (dkimRes.success) {
      dkimGenerated = true;
      const dkimInfo = this.dkim.getDkimInfo(domain, this.config.dkimSelector);
      if (dkimInfo.exists) {
        dkimVal = dkimInfo.dnsValue;
      }
    } else {
      dkimGenerated = false;
      dkimVal = undefined;
      errors.push(`DKIM generation failed: ${(dkimRes.stderr || dkimRes.stdout).trim()}`);
    }

    // 3. Create users / forwarders / quotas
    const accountsAdded: string[] = [];
    const aliasesAdded: string[] = [];
    const existing = new Set(this.dms.listAccounts().map((a) => a.email.toLowerCase()));
    const failure = (r: ExecResult) => (r.stderr || r.stdout).trim() || `exit code ${r.code}`;

    if (options.users && options.users.length > 0) {
      for (const u of options.users) {
        const email = `${u}@${domain}`;
        if (options.forward) {
          const res = this.dms.addAlias(email, options.forward);
          if (res.success) aliasesAdded.push(`${email} -> ${options.forward}`);
          else errors.push(`alias ${email}: ${failure(res)}`);
        } else if (existing.has(email.toLowerCase())) {
          errors.push(`mailbox ${email} already exists; left unchanged`);
        } else {
          const res = this.dms.addAccount(email, options.password);
          if (!res.success) {
            errors.push(`mailbox ${email}: ${failure(res)}`);
            continue;
          }
          accountsAdded.push(email);
          if (options.quota) {
            const q = this.dms.setQuota(email, options.quota);
            if (!q.success) errors.push(`quota for ${email}: ${failure(q)}`);
          }
        }
      }
    }

    // 4. Cloudflare DNS sync
    let dnsSyncResult: any = undefined;
    if (options.syncDns && this.cf.isConfigured()) {
      dnsSyncResult = await this.cf.syncDomainDns({
        domain,
        mxHost: this.config.mxHost,
        dkimSelector: this.config.dkimSelector,
        dkimValue: dkimVal,
      });
    }

    return {
      domain,
      dkimGenerated,
      dkimValue: dkimVal,
      dnsSyncResult,
      accountsAdded,
      aliasesAdded,
      errors,
    };
  }

  /**
   * Removes a virtual domain, DKIM keys, mailboxes, and optionally Cloudflare DNS & mail data
   */
  public async removeDomain(options: RemoveDomainOptions): Promise<{
    domain: string;
    removedFromEnv: boolean;
    dkimRemoved: boolean;
    dataDeleted: boolean;
    dnsDeletedResult?: any;
    accountsDeleted: string[];
    errors: string[];
  }> {
    const domain = normalizeDomain(options.domain);
    const errors: string[] = [];

    if (domain === normalizeDomain(this.config.primaryDomain)) {
      throw new Error(`Cannot remove the primary domain (${this.config.primaryDomain}).`);
    }

    // 1. Remove from mailserver.env
    const removedFromEnv = this.envManager.removeVirtualDomain(domain);

    // 2. Remove specified or all accounts for this domain
    const accounts = this.dms.listAccounts().filter((a) => a.domain.toLowerCase() === domain);
    const accountsDeleted: string[] = [];

    for (const a of accounts) {
      if (!options.users || options.users.length === 0 || options.users.includes(a.username)) {
        const res = this.dms.delAccount(a.email);
        if (res.success) accountsDeleted.push(a.email);
        else errors.push(`mailbox ${a.email}: ${(res.stderr || res.stdout).trim() || `exit code ${res.code}`}`);
      }
    }

    // 3. Remove DKIM files
    let dkimRemoved = false;
    const opendkimDir = path.join(this.config.opendkimKeysPath, domain);
    const rspamdDir = path.join(this.config.rspamdDkimPath, domain);
    if (fs.existsSync(opendkimDir)) {
      fs.rmSync(opendkimDir, { recursive: true, force: true });
      dkimRemoved = true;
    }
    if (fs.existsSync(rspamdDir)) {
      fs.rmSync(rspamdDir, { recursive: true, force: true });
      dkimRemoved = true;
    }

    // 4. Delete mail data if requested
    let dataDeleted = false;
    if (options.deleteData) {
      const mailDir = path.join(this.config.mailDataPath, domain);
      if (fs.existsSync(mailDir)) {
        fs.rmSync(mailDir, { recursive: true, force: true });
        dataDeleted = true;
      }
    }

    // 5. Delete Cloudflare DNS records if requested
    let dnsDeletedResult: any = undefined;
    if (options.deleteDns && this.cf.isConfigured()) {
      dnsDeletedResult = await this.cf.deleteDomainDns(domain, this.config.dkimSelector);
    }

    return {
      domain,
      removedFromEnv,
      dkimRemoved,
      dataDeleted,
      dnsDeletedResult,
      accountsDeleted,
      errors,
    };
  }

  /**
   * Syncs DNS for a domain to Cloudflare
   */
  public async syncDns(domain: string): Promise<any> {
    const norm = normalizeDomain(domain);
    const dkimInfo = this.dkim.getDkimInfo(norm, this.config.dkimSelector);
    return this.cf.syncDomainDns({
      domain: norm,
      mxHost: this.config.mxHost,
      dkimSelector: this.config.dkimSelector,
      dkimValue: dkimInfo.dnsValue,
    });
  }
}
