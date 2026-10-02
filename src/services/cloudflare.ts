import { CloudflareDnsRecord, CloudflareZone } from '../types.js';
import { isCloudflareRoutingMx, spfManagedElsewhere } from './dns.js';

export interface CloudflareApiResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
}

/**
 * Strips the outer quotes Cloudflare sometimes adds to / strips from TXT content.
 */
export function normalizeTxtContent(c: string): string {
  return c.replace(/^"|"$/g, '').trim();
}

/**
 * Leading tag of a TXT record: the part before the first space or semicolon,
 * lowercased ("v=spf1", "v=dmarc1", "v=dkim1", "google-site-verification=…").
 * SPF is space-delimited, DKIM/DMARC semicolon-delimited, so one split covers both.
 */
export function txtLeadingTag(c: string): string {
  return normalizeTxtContent(c).split(/[;\s]/)[0].toLowerCase();
}

/**
 * Picks which existing TXT record (same name) a desired record corresponds to.
 *
 * Several TXT records can share a name — e.g. SPF and a site-verification
 * record at the apex. Matching is done on the leading tag, so syncing SPF can
 * never clobber an unrelated record. Returns undefined (→ create a new record)
 * when nothing matches; when several records share the tag (duplicates), the
 * one whose full content already matches is preferred.
 */
export function selectTxtTarget(
  existing: CloudflareDnsRecord[],
  desired: CloudflareDnsRecord,
): CloudflareDnsRecord | undefined {
  const tag = txtLeadingTag(desired.content);
  const candidates = existing.filter((r) => txtLeadingTag(r.content) === tag);
  if (candidates.length === 1) {
    return candidates[0];
  }
  if (candidates.length > 1) {
    return candidates.find((r) => normalizeTxtContent(r.content) === normalizeTxtContent(desired.content)) ?? candidates[0];
  }
  return undefined;
}

export class CloudflareService {
  private apiToken: string | undefined;
  private baseUrl = 'https://api.cloudflare.com/client/v4';

  constructor(apiToken?: string) {
    this.apiToken = apiToken || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiToken && this.apiToken.trim().length > 0);
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (!this.apiToken) {
      throw new Error('Cloudflare API Token (CF_API_TOKEN) is not configured.');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    const data = (await response.json()) as CloudflareApiResponse<T>;

    if (!data.success) {
      const errorMsg = data.errors?.map((e) => `[${e.code}] ${e.message}`).join(', ') || response.statusText;
      throw new Error(`Cloudflare API error: ${errorMsg}`);
    }

    return data.result;
  }

  /**
   * Lists every zone the API token can see, sorted by name.
   */
  public async listZones(): Promise<CloudflareZone[]> {
    const perPage = 50;
    const zones: CloudflareZone[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<CloudflareZone[]>(`/zones?per_page=${perPage}&page=${page}`);
      zones.push(...batch);
      if (batch.length < perPage) break;
    }
    return zones.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Finds the best matching Zone ID for a given domain or subdomain.
   * Walks up the domain labels (e.g. sub.example.com -> example.com) to find the zone.
   */
  public async getZoneForDomain(domain: string): Promise<CloudflareZone | null> {
    const parts = domain.toLowerCase().split('.');
    
    // Check from exact match up to apex (minimum 2 labels)
    for (let i = 0; i <= parts.length - 2; i++) {
      const candidate = parts.slice(i).join('.');
      try {
        const zones = await this.request<CloudflareZone[]>(`/zones?name=${encodeURIComponent(candidate)}&status=active`);
        if (zones && zones.length > 0) {
          return zones[0];
        }
      } catch (err) {
        // If exact query fails or lacks permissions, continue
      }
    }

    // Fallback: list all available zones and check suffix match
    try {
      const allZones = await this.request<CloudflareZone[]>('/zones?per_page=50');
      if (allZones) {
        // Sort descending by name length to find the most specific zone
        const matches = allZones
          .filter((z) => domain.toLowerCase() === z.name.toLowerCase() || domain.toLowerCase().endsWith(`.${z.name.toLowerCase()}`))
          .sort((a, b) => b.name.length - a.name.length);
        if (matches.length > 0) {
          return matches[0];
        }
      }
    } catch {
      // Ignore fallback failure
    }

    return null;
  }

  /**
   * Lists DNS records in a zone matching query parameters
   */
  public async listRecords(zoneId: string, filter?: { name?: string; type?: string }): Promise<CloudflareDnsRecord[]> {
    let query = `/zones/${zoneId}/dns_records?per_page=100`;
    if (filter?.name) query += `&name=${encodeURIComponent(filter.name)}`;
    if (filter?.type) query += `&type=${encodeURIComponent(filter.type)}`;

    return this.request<CloudflareDnsRecord[]>(query);
  }

  /**
   * Creates a DNS record
   */
  public async createRecord(zoneId: string, record: CloudflareDnsRecord): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl ?? 1, // 1 = auto
        priority: record.priority,
        proxied: false, // Mail records must not be proxied
        comment: record.comment || 'Managed by cf-mail-tui',
      }),
    });
  }

  /**
   * Updates an existing DNS record
   */
  public async updateRecord(zoneId: string, recordId: string, record: CloudflareDnsRecord): Promise<CloudflareDnsRecord> {
    return this.request<CloudflareDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify({
        type: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl ?? 1,
        priority: record.priority,
        proxied: false,
        comment: record.comment || 'Managed by cf-mail-tui',
      }),
    });
  }

  /**
   * Deletes a DNS record
   */
  public async deleteRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    return this.request<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Upsert (find and create or update) a DNS record
   */
  public async upsertRecord(zoneId: string, record: CloudflareDnsRecord): Promise<{ action: 'created' | 'updated' | 'unchanged'; record: CloudflareDnsRecord }> {
    const existingList = await this.listRecords(zoneId, {
      name: record.name,
      type: record.type,
    });

    let target: CloudflareDnsRecord | undefined;
    if (record.type === 'MX') {
      // Find matching MX record
      target = existingList.find((r) => r.content.toLowerCase() === record.content.toLowerCase());
    } else if (record.type === 'TXT') {
      // TXT records can share a name (SPF + site-verification at the apex);
      // identify ours by leading tag, never by list position.
      target = selectTxtTarget(existingList, record);
    }

    if (target && target.id) {
      const contentChanged = normalizeTxtContent(target.content) !== normalizeTxtContent(record.content);
      const priorityChanged = record.type === 'MX' && target.priority !== record.priority;

      if (!contentChanged && !priorityChanged) {
        return { action: 'unchanged', record: target };
      }

      const updated = await this.updateRecord(zoneId, target.id, record);
      return { action: 'updated', record: updated };
    }

    const created = await this.createRecord(zoneId, record);
    return { action: 'created', record: created };
  }

  /**
   * Synchronizes all required email DNS records (MX, SPF, DKIM, DMARC) for a domain to Cloudflare
   */
  public async syncDomainDns(options: {
    domain: string;
    mxHost: string;
    dkimSelector: string;
    dkimValue?: string;
    spfValue?: string;
    dmarcValue?: string;
  }): Promise<{
    zone: CloudflareZone;
    results: Array<{ recordType: string; name: string; action: 'created' | 'updated' | 'unchanged'; error?: string }>;
  }> {
    const { domain, mxHost, dkimSelector } = options;
    const zone = await this.getZoneForDomain(domain);
    if (!zone) {
      throw new Error(`No active Cloudflare Zone found for domain: ${domain}`);
    }

    const results: Array<{ recordType: string; name: string; action: 'created' | 'updated' | 'unchanged'; error?: string }> = [];

    // 1. MX Record. With Cloudflare Email Routing the MX hosts are Cloudflare's; adding the mail host
    // beside them would send some mail to a server that never receives it.
    const existingMx = await this.listRecords(zone.id, { name: domain, type: 'MX' }).catch(() => []);
    if (existingMx.some((r) => isCloudflareRoutingMx(r.content))) {
      results.push({ recordType: 'MX', name: domain, action: 'unchanged' });
    } else try {
      const mxRes = await this.upsertRecord(zone.id, {
        type: 'MX',
        name: domain,
        content: mxHost,
        priority: 10,
        ttl: 1,
        proxied: false,
      });
      results.push({ recordType: 'MX', name: domain, action: mxRes.action });
    } catch (err: any) {
      results.push({ recordType: 'MX', name: domain, action: 'unchanged', error: err.message });
    }

    // 2. SPF TXT Record
    const spfContent = options.spfValue || 'v=spf1 mx ~all';
    // Keep an SPF that already authorises Cloudflare Email Routing / Postmark; the default would drop them.
    const existingTxt = await this.listRecords(zone.id, { name: domain, type: 'TXT' }).catch(() => []);
    const managedSpf = existingTxt.find((r) => /^"?v=spf1/i.test(r.content) && spfManagedElsewhere(r.content));
    if (managedSpf && !options.spfValue) {
      results.push({ recordType: 'SPF (TXT)', name: domain, action: 'unchanged' });
    } else try {
      const spfRes = await this.upsertRecord(zone.id, {
        type: 'TXT',
        name: domain,
        content: spfContent,
        ttl: 1,
        proxied: false,
      });
      results.push({ recordType: 'SPF (TXT)', name: domain, action: spfRes.action });
    } catch (err: any) {
      results.push({ recordType: 'SPF (TXT)', name: domain, action: 'unchanged', error: err.message });
    }

    // 3. DKIM TXT Record
    if (options.dkimValue) {
      const dkimName = `${dkimSelector}._domainkey.${domain}`;
      try {
        const dkimRes = await this.upsertRecord(zone.id, {
          type: 'TXT',
          name: dkimName,
          content: options.dkimValue,
          ttl: 1,
          proxied: false,
        });
        results.push({ recordType: 'DKIM (TXT)', name: dkimName, action: dkimRes.action });
      } catch (err: any) {
        results.push({ recordType: 'DKIM (TXT)', name: dkimName, action: 'unchanged', error: err.message });
      }
    }

    // 4. DMARC TXT Record
    const dmarcContent = options.dmarcValue || 'v=DMARC1; p=none; sp=none; aspf=r;';
    const dmarcName = `_dmarc.${domain}`;
    try {
      const dmarcRes = await this.upsertRecord(zone.id, {
        type: 'TXT',
        name: dmarcName,
        content: dmarcContent,
        ttl: 1,
        proxied: false,
      });
      results.push({ recordType: 'DMARC (TXT)', name: dmarcName, action: dmarcRes.action });
    } catch (err: any) {
      results.push({ recordType: 'DMARC (TXT)', name: dmarcName, action: 'unchanged', error: err.message });
    }

    return { zone, results };
  }

  /**
   * Deletes mail-related DNS records from Cloudflare for a removed domain
   */
  public async deleteDomainDns(domain: string, dkimSelector = 'mail'): Promise<{ deletedCount: number; records: string[] }> {
    const zone = await this.getZoneForDomain(domain);
    if (!zone) {
      return { deletedCount: 0, records: [] };
    }

    const records = await this.listRecords(zone.id);
    const deleted: string[] = [];

    const dkimTarget = `${dkimSelector}._domainkey.${domain}`.toLowerCase();
    const dmarcTarget = `_dmarc.${domain}`.toLowerCase();
    const domainLower = domain.toLowerCase();

    for (const r of records) {
      if (!r.id) continue;
      const rName = r.name.toLowerCase();

      let shouldDelete = false;
      if (r.type === 'MX' && rName === domainLower) {
        shouldDelete = true;
      } else if (r.type === 'TXT' && rName === domainLower && r.content.includes('v=spf1')) {
        shouldDelete = true;
      } else if (r.type === 'TXT' && rName === dkimTarget) {
        shouldDelete = true;
      } else if (r.type === 'TXT' && rName === dmarcTarget) {
        shouldDelete = true;
      }

      if (shouldDelete) {
        try {
          await this.deleteRecord(zone.id, r.id);
          deleted.push(`${r.type} ${r.name}`);
        } catch {
          // ignore individual deletion error
        }
      }
    }

    return { deletedCount: deleted.length, records: deleted };
  }
}
