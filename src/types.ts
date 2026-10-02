export interface AppConfig {
  primaryDomain: string;
  mxHost: string;
  dkimSelector: string;
  projectDir: string;
  composeFilePath: string;
  mailserverEnvPath: string;
  mailDataPath: string;
  configDirPath: string;
  opendkimKeysPath: string;
  rspamdDkimPath: string;
  cloudflareApiToken?: string;
  postmasterAddress: string;
  sslType: string;
  /** Cloudflare zones the TUI should not list (TUI_HIDE_ZONES, comma separated). Display only. */
  hiddenZones: string[];
}

export interface DnsCheckItem {
  status: 'valid' | 'missing' | 'invalid' | 'unknown';
  records: string[];
  expected?: string;
  detail?: string;
}

export interface DomainDnsStatus {
  mx: DnsCheckItem;
  spf: DnsCheckItem;
  dkim: DnsCheckItem;
  dmarc: DnsCheckItem;
}

export interface DomainInfo {
  domain: string;
  isPrimary: boolean;
  mailboxCount: number;
  dkimExists: boolean;
  dkimSelector: string;
  dkimRecordValue?: string;
  dnsStatus: DomainDnsStatus;
}

export interface MailboxAccount {
  email: string;
  domain: string;
  username: string;
  quota?: string;
}

export interface MailboxAlias {
  source: string;
  destination: string;
}

export interface CloudflareDnsRecord {
  id?: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV';
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  proxied?: boolean;
  comment?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

export interface AddDomainOptions {
  domain: string;
  users?: string[];
  password?: string;
  quota?: string;
  forward?: string;
  syncDns?: boolean;
}

export interface RemoveDomainOptions {
  domain: string;
  users?: string[];
  deleteData?: boolean;
  deleteDns?: boolean;
}

export interface ExpectedDnsRecords {
  domain: string;
  mx: { host: string; priority: number };
  spf: string;
  dkim: { selector: string; name: string; value: string };
  dmarc: { name: string; value: string };
}
