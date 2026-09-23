import dns from 'node:dns/promises';
import { DomainDnsStatus, DnsCheckItem } from '../types.js';

export class DnsCheckerService {
  /**
   * Resolves MX records for a domain
   */
  public async checkMx(domain: string, expectedMxHost?: string): Promise<DnsCheckItem> {
    try {
      const records = await dns.resolveMx(domain);
      if (!records || records.length === 0) {
        return {
          status: 'missing',
          records: [],
          expected: expectedMxHost,
          detail: 'No MX records found',
        };
      }

      const formatted = records.map((r) => `${r.priority} ${r.exchange}`);
      if (expectedMxHost) {
        const matches = records.some((r) => r.exchange.toLowerCase() === expectedMxHost.toLowerCase() || r.exchange.toLowerCase() === `${expectedMxHost.toLowerCase()}.`);
        return {
          status: matches ? 'valid' : 'invalid',
          records: formatted,
          expected: expectedMxHost,
          detail: matches ? 'MX points to mail server' : `MX does not match expected host (${expectedMxHost})`,
        };
      }

      return {
        status: 'valid',
        records: formatted,
      };
    } catch (err: any) {
      return {
        status: 'missing',
        records: [],
        expected: expectedMxHost,
        detail: err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'Record not found' : err.message,
      };
    }
  }

  /**
   * Resolves SPF TXT record for a domain
   */
  public async checkSpf(domain: string): Promise<DnsCheckItem> {
    try {
      const txtChunks = await dns.resolveTxt(domain);
      const txtRecords = txtChunks.map((chunk) => chunk.join(''));
      const spf = txtRecords.find((r) => r.toLowerCase().startsWith('v=spf1'));

      if (!spf) {
        return {
          status: 'missing',
          records: txtRecords,
          expected: 'v=spf1 mx ~all',
          detail: 'No SPF record found',
        };
      }

      return {
        status: 'valid',
        records: [spf],
        detail: 'SPF record published',
      };
    } catch (err: any) {
      return {
        status: 'missing',
        records: [],
        expected: 'v=spf1 mx ~all',
        detail: err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'Record not found' : err.message,
      };
    }
  }

  /**
   * Resolves DKIM TXT record
   */
  public async checkDkim(domain: string, selector = 'mail'): Promise<DnsCheckItem> {
    const dkimHost = `${selector}._domainkey.${domain}`;
    try {
      const txtChunks = await dns.resolveTxt(dkimHost);
      const txtRecords = txtChunks.map((chunk) => chunk.join(''));
      const dkim = txtRecords.find((r) => r.toLowerCase().includes('v=dkim1') || r.toLowerCase().includes('p='));

      if (!dkim) {
        return {
          status: 'missing',
          records: txtRecords,
          expected: 'v=DKIM1; k=rsa; p=...',
          detail: 'No DKIM record at ' + dkimHost,
        };
      }

      return {
        status: 'valid',
        records: [dkim],
        detail: 'DKIM record published',
      };
    } catch (err: any) {
      return {
        status: 'missing',
        records: [],
        expected: 'v=DKIM1; k=rsa; p=...',
        detail: err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'Record not found' : err.message,
      };
    }
  }

  /**
   * Resolves DMARC TXT record
   */
  public async checkDmarc(domain: string): Promise<DnsCheckItem> {
    const dmarcHost = `_dmarc.${domain}`;
    try {
      const txtChunks = await dns.resolveTxt(dmarcHost);
      const txtRecords = txtChunks.map((chunk) => chunk.join(''));
      const dmarc = txtRecords.find((r) => r.toLowerCase().startsWith('v=dmarc1'));

      if (!dmarc) {
        return {
          status: 'missing',
          records: txtRecords,
          expected: 'v=DMARC1; p=none; ...',
          detail: 'No DMARC record found',
        };
      }

      return {
        status: 'valid',
        records: [dmarc],
        detail: 'DMARC record published',
      };
    } catch (err: any) {
      return {
        status: 'missing',
        records: [],
        expected: 'v=DMARC1; p=none; sp=none; aspf=r;',
        detail: err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? 'Record not found' : err.message,
      };
    }
  }

  /**
   * Performs complete DNS check for a domain
   */
  public async checkAll(domain: string, expectedMxHost?: string, selector = 'mail'): Promise<DomainDnsStatus> {
    const [mx, spf, dkim, dmarc] = await Promise.all([
      this.checkMx(domain, expectedMxHost),
      this.checkSpf(domain),
      this.checkDkim(domain, selector),
      this.checkDmarc(domain),
    ]);

    return { mx, spf, dkim, dmarc };
  }
}
