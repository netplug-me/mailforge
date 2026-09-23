import fs from 'node:fs';
import path from 'node:path';

export class EnvFileManager {
  private filePath: string;
  private lines: string[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  public load(): void {
    if (fs.existsSync(this.filePath)) {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      this.lines = content.split(/\r?\n/);
    } else {
      this.lines = [];
    }
  }

  public save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, this.lines.join('\n'), 'utf-8');
  }

  public get(key: string): string | undefined {
    for (const line of this.lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = line.indexOf('=');
      const k = line.substring(0, eqIdx).trim();
      if (k === key) {
        let val = line.substring(eqIdx + 1).trim();
        if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
          val = val.substring(1, val.length - 1);
        }
        return val;
      }
    }
    return undefined;
  }

  public set(key: string, value: string, quote = true): void {
    const formattedVal = quote ? `'${value}'` : value;
    let found = false;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i].trim();
      if (line.startsWith('#') || !line.includes('=')) continue;
      const eqIdx = this.lines[i].indexOf('=');
      const k = this.lines[i].substring(0, eqIdx).trim();
      if (k === key) {
        this.lines[i] = `${key}=${formattedVal}`;
        found = true;
        break;
      }
    }
    if (!found) {
      this.lines.push(`${key}=${formattedVal}`);
    }
  }

  public remove(key: string): void {
    this.lines = this.lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) return true;
      const eqIdx = line.indexOf('=');
      const k = line.substring(0, eqIdx).trim();
      return k !== key;
    });
  }

  public getVirtualDomains(): string[] {
    const raw = this.get('POSTFIX_VIRTUAL_DOMAINS');
    if (!raw) return [];
    // Can be comma or space separated
    return raw
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
  }

  public addVirtualDomain(domain: string): boolean {
    const d = domain.trim().toLowerCase();
    const domains = this.getVirtualDomains();
    if (domains.includes(d)) {
      return false; // already present
    }
    domains.push(d);
    // Docker Mailserver standard format: comma or space separated inside quotes
    this.set('POSTFIX_VIRTUAL_DOMAINS', domains.join(','));
    this.save();
    return true;
  }

  public removeVirtualDomain(domain: string): boolean {
    const d = domain.trim().toLowerCase();
    const domains = this.getVirtualDomains();
    const filtered = domains.filter((item) => item !== d);
    if (filtered.length === domains.length) {
      return false; // not present
    }
    if (filtered.length === 0) {
      this.remove('POSTFIX_VIRTUAL_DOMAINS');
    } else {
      this.set('POSTFIX_VIRTUAL_DOMAINS', filtered.join(','));
    }
    this.save();
    return true;
  }
}
