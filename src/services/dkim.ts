import fs from 'node:fs';
import path from 'node:path';
import { getAppConfig } from '../config.js';

export interface DkimFileInfo {
  exists: boolean;
  filePath?: string;
  selector: string;
  domain: string;
  rawText?: string;
  dnsValue?: string;
}

export class DkimService {
  private projectDir: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir || getAppConfig().projectDir;
  }

  /**
   * Finds the DKIM key file path for a domain
   */
  public findDkimFile(domain: string, selector = 'mail'): string | null {
    const config = getAppConfig(this.projectDir);
    const candidatePaths = [
      path.join(config.opendkimKeysPath, domain, `${selector}.txt`),
      path.join(config.opendkimKeysPath, domain, 'mail.txt'),
      path.join(config.rspamdDkimPath, domain, `${selector}.txt`),
      path.join(config.rspamdDkimPath, `${domain}.txt`),
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }

  /**
   * Reads and extracts DKIM TXT record content from OpenDKIM/Rspamd key file
   */
  public getDkimInfo(domain: string, selector = 'mail'): DkimFileInfo {
    const filePath = this.findDkimFile(domain, selector);
    if (!filePath) {
      return {
        exists: false,
        selector,
        domain,
      };
    }

    try {
      const rawText = fs.readFileSync(filePath, 'utf-8');
      const dnsValue = this.parseDkimTxtRecord(rawText);
      return {
        exists: true,
        filePath,
        selector,
        domain,
        rawText,
        dnsValue,
      };
    } catch {
      return {
        exists: false,
        selector,
        domain,
      };
    }
  }

  /**
   * Parses raw OpenDKIM text output into a clean TXT value
   * Example input:
   *   mail._domainkey.example.com. IN TXT ( "v=DKIM1; k=rsa; "
   *     "p=MIIBIjANBgkq..." ) ; ----- DKIM key mail for example.com
   * Output:
   *   v=DKIM1; k=rsa; p=MIIBIjANBgkq...
   */
  public parseDkimTxtRecord(rawContent: string): string {
    // Extract everything between quotes and concatenate
    const matches: string[] = [];
    const regex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(rawContent)) !== null) {
      matches.push(match[1]);
    }

    if (matches.length > 0) {
      return matches.join('');
    }

    // Fallback: clean up parentheses and semicolons
    return rawContent
      .replace(/^[^"]*IN\s+TXT\s*\(\s*/i, '')
      .replace(/\s*\)\s*;.*$/s, '')
      .replace(/"/g, '')
      .replace(/\r?\n/g, '')
      .trim();
  }
}
