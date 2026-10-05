import React from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { getAppConfig } from '../config.js';
import { formatKb, QuotaRow } from '../services/ops.js';
import { DnsCheckItem, DomainInfo, MailboxAccount, MailboxAlias } from '../types.js';
import { C, bar, fit, truncate, usageColor, windowStart } from './theme.js';
import { isCancel, DashboardData, OutputLine, UiState, ui } from './ui.js';
import { OutputLineView, Panel, windowLines } from './widgets.js';
import {
  FlowContext,
  addAliasFlow,
  addDomainFlow,
  addMailboxFlow,
  deleteAccountFlow,
  deleteAliasFlow,
  dkimFlow,
  removeDomainFlow,
  resetPasswordFlow,
  setQuotaFlow,
  syncDnsFlow,
} from './flows.js';
import {
  actionDockerControl,
  toolCertificate,
  toolClients,
  toolDeliveryLog,
  toolFail2ban,
  toolMailQueue,
  toolPipeline,
  toolPostmark,
  toolQuotas,
  toolSendTest,
} from './actions.js';

// ── Shared ───────────────────────────────────────────────────────────────────

export type ScreenKey = 'mailboxes' | 'domains' | 'tools';

export interface Nav {
  screen: ScreenKey;
  mbxSel: number;
  /** 0 = all domains, n = the (n-1)th registered domain. */
  mbxFilter: number;
  domSel: number;
  toolSel: number;
  /** Lines scrolled up from the newest in the Tools output. */
  outScroll: number;
}

export interface ScreenProps {
  dashboard: DashboardData;
  ctx: FlowContext;
  width: number;
  height: number;
  active: boolean;
  nav: Nav;
  patchNav: (patch: Partial<Nav>) => void;
  /** Runs a flow: blocks keys while it runs and reports errors as a toast. */
  run: (fn: () => Promise<void>) => void;
}

interface Seg {
  t: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

/** One list row built from coloured segments, padded to `width` so a selection highlight spans it. */
function Line({ segs, width, selected }: { segs: Seg[]; width: number; selected?: boolean }) {
  const used = segs.reduce((n, s) => n + stringWidth(s.t), 0);
  return (
    <Text wrap="truncate" backgroundColor={selected ? C.selectedBg : undefined}>
      {segs.map((s, i) => (
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim}>
          {s.t}
        </Text>
      ))}
      {used < width ? ' '.repeat(width - used) : ''}
    </Text>
  );
}

function Detail({ label, children, labelWidth = 10 }: { label: string; children: React.ReactNode; labelWidth?: number }) {
  return (
    <Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
      {children}
    </Box>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function webmailUrl(): string | undefined {
  const host = process.env.WEBMAIL_HOSTNAME?.trim();
  return host ? `https://${host}` : undefined;
}

// ── Mailboxes ────────────────────────────────────────────────────────────────

type MbxRow =
  | { type: 'domain'; domain: string; mailboxes: number; aliases: number }
  | { type: 'account'; account: MailboxAccount }
  | { type: 'alias'; alias: MailboxAlias };

export function buildMailboxRows(dashboard: DashboardData, filter: number): { rows: MbxRow[]; domains: string[] } {
  const registered = dashboard.domains.map((d) => d.domain);
  const aliasDomain = (a: MailboxAlias) => a.source.split('@')[1]?.toLowerCase() ?? '';
  const known = new Set(registered);
  const extra = [
    ...dashboard.accounts.map((a) => a.domain),
    ...dashboard.aliases.map(aliasDomain),
  ].filter((d) => d && !known.has(d));
  const domains = [...registered, ...new Set(extra)];
  const shown = filter > 0 && domains[filter - 1] ? [domains[filter - 1]] : domains;

  const rows: MbxRow[] = [];
  for (const domain of shown) {
    const accounts = dashboard.accounts
      .filter((a) => a.domain === domain)
      .sort((a, b) => a.username.localeCompare(b.username));
    const aliases = dashboard.aliases
      .filter((a) => aliasDomain(a) === domain)
      .sort((a, b) => a.source.localeCompare(b.source));
    rows.push({ type: 'domain', domain, mailboxes: accounts.length, aliases: aliases.length });
    for (const account of accounts) rows.push({ type: 'account', account });
    for (const alias of aliases) rows.push({ type: 'alias', alias });
  }
  return { rows, domains };
}

function usageOf(dashboard: DashboardData, email: string): QuotaRow | undefined {
  return dashboard.usage?.[email.toLowerCase()];
}

function MailboxDetail({
  row,
  dashboard,
  width,
  height,
}: {
  row?: MbxRow;
  dashboard: DashboardData;
  width: number;
  height: number;
}) {
  const config = getAppConfig();
  const webmail = webmailUrl();
  const inner = width - 4;
  const title = !row || row.type === 'domain' ? 'Details' : row.type === 'account' ? row.account.email : row.alias.source;
  return (
    <Panel title={title} color={C.accent2} width={width} height={height}>
      {row?.type === 'account' && (() => {
        const u = usageOf(dashboard, row.account.email);
        const frac = u?.limitKb ? u.usedKb / u.limitKb : 0;
        return (
          <>
            <Text bold color={C.violet}>
              Mailbox
            </Text>
            <Detail label="Storage">
              {u ? (
                <Text>
                  <Text color={u.limitKb ? usageColor(frac) : C.faint}>{bar(frac, 12)}</Text>
                  <Text> {u.limitKb ? `${Math.round(frac * 100)}%` : 'no limit'}</Text>
                </Text>
              ) : (
                <Text dimColor>unknown</Text>
              )}
            </Detail>
            <Detail label="Used">
              <Text wrap="truncate">
                {u ? `${formatKb(u.usedKb)}${u.limitKb ? ` of ${formatKb(u.limitKb)}` : ''}` : '—'}
              </Text>
            </Detail>
            <Detail label="Messages">
              <Text>{u ? u.messages : '—'}</Text>
            </Detail>
            <Box marginTop={1} flexDirection="column">
              <Text bold color={C.violet}>
                Mail app settings
              </Text>
              <Detail label="Username">
                <Text wrap="truncate-middle">{row.account.email}</Text>
              </Detail>
              <Detail label="Server">
                <Text wrap="truncate">{config.mxHost}</Text>
              </Detail>
              <Detail label="IMAP">
                <Text wrap="truncate">993 SSL/TLS</Text>
              </Detail>
              <Detail label="SMTP">
                <Text wrap="truncate">587 STARTTLS · 465 SSL/TLS</Text>
              </Detail>
              {webmail && (
                <Detail label="Webmail">
                  <Text wrap="truncate-middle" color={C.accent}>
                    {truncate(webmail, inner - 10)}
                  </Text>
                </Detail>
              )}
            </Box>
          </>
        );
      })()}
      {row?.type === 'alias' && (
        <>
          <Text bold color={C.violet}>
            Forwarder
          </Text>
          <Detail label="From">
            <Text wrap="truncate-middle">{row.alias.source}</Text>
          </Detail>
          <Detail label="To">
            <Text wrap="truncate-middle">{row.alias.destination}</Text>
          </Detail>
        </>
      )}
      {(!row || row.type === 'domain') && <Text dimColor>Select a mailbox or alias.</Text>}
    </Panel>
  );
}

export function MailboxesScreen({ dashboard, ctx, width, height, active, nav, patchNav, run }: ScreenProps) {
  const { rows, domains } = buildMailboxRows(dashboard, nav.mbxFilter);
  const selectable = rows.map((r, i) => (r.type === 'domain' ? -1 : i)).filter((i) => i >= 0);
  const sel = clamp(nav.mbxSel, 0, Math.max(0, selectable.length - 1));
  const selRowIndex = selectable[sel] ?? -1;
  const selRow = selRowIndex >= 0 ? rows[selRowIndex] : undefined;
  const filterDomain = nav.mbxFilter > 0 ? domains[nav.mbxFilter - 1] : undefined;
  const contextDomain =
    filterDomain ?? (selRow?.type === 'account' ? selRow.account.domain : selRow?.type === 'alias' ? selRow.alias.source.split('@')[1] : undefined);

  /** The flow for an action on the selected row, or undefined when it does not apply. */
  const actionFor = (kind: 'password' | 'quota' | 'delete'): (() => Promise<void>) | undefined => {
    if (!selRow || selRow.type === 'domain') return undefined;
    if (selRow.type === 'alias') return kind === 'delete' ? () => deleteAliasFlow(ctx, selRow.alias) : undefined;
    const email = selRow.account.email;
    if (kind === 'password') return () => resetPasswordFlow(ctx, email);
    if (kind === 'quota') {
      const limit = usageOf(dashboard, email)?.limitKb;
      return () => setQuotaFlow(ctx, email, limit ? formatKb(limit).replace('.0', '') : undefined);
    }
    return () => deleteAccountFlow(ctx, email);
  };
  const act = (kind: 'password' | 'quota' | 'delete') => {
    const flow = actionFor(kind);
    if (flow) run(flow);
  };

  useInput(
    (input, key) => {
      const move = (d: number) => patchNav({ mbxSel: clamp(sel + d, 0, Math.max(0, selectable.length - 1)) });
      if (key.upArrow || input === 'k') move(-1);
      else if (key.downArrow || input === 'j') move(1);
      else if (key.pageUp) move(-10);
      else if (key.pageDown) move(10);
      else if (input === 'a') run(() => addMailboxFlow(ctx, contextDomain));
      else if (input === 'l') run(() => addAliasFlow(ctx, contextDomain));
      else if (input === 'p') act('password');
      else if (input === 'q') act('quota');
      else if (input === 'd' || key.delete) act('delete');
      else if (input === 'f') patchNav({ mbxFilter: (nav.mbxFilter + 1) % (domains.length + 1), mbxSel: 0 });
      else if (input === 'F') patchNav({ mbxFilter: (nav.mbxFilter - 1 + domains.length + 1) % (domains.length + 1), mbxSel: 0 });
      else if (key.return && selRow && selRow.type !== 'domain') {
        run(async () => {
          const isAccount = selRow.type === 'account';
          const choice = await ui.select(isAccount ? selRow.account.email : selRow.alias.source, [
            ...(isAccount
              ? [
                  { value: 'password', label: 'Change password', icon: '⚿', color: C.violet },
                  { value: 'quota', label: 'Set quota', icon: '▰', color: C.warn },
                ]
              : []),
            { value: 'delete', label: 'Delete', icon: '✖', color: C.bad },
            { value: 'back', label: 'Back', icon: '←', color: C.muted },
          ]);
          if (isCancel(choice) || choice === 'back') return;
          await actionFor(choice as 'password' | 'quota' | 'delete')?.();
        });
      }
    },
    { isActive: active }
  );

  const showDetail = width >= 104;
  const detailWidth = showDetail ? 40 : 0;
  const listWidth = width - detailWidth - (showDetail ? 1 : 0);
  const W = listWidth - 4;
  const rowsAvail = Math.max(1, height - 3);

  const colsKind = W >= 78 ? 4 : W >= 62 ? 3 : W >= 44 ? 2 : 0;
  const barW = colsKind >= 3 ? 11 : 0;
  const pctW = colsKind >= 2 ? 6 : 0;
  const sizeW = colsKind >= 2 ? 16 : 0;
  const msgW = colsKind >= 4 ? 9 : 0;
  const addrW = Math.max(10, W - 2 - barW - pctW - sizeW - msgW);

  // One row of the panel is the column header.
  const dataRows = Math.max(1, rowsAvail - 1);
  const start = windowStart(selRowIndex >= 0 ? selRowIndex : 0, rows.length, dataRows);
  const visible = rows.slice(start, start + dataRows);

  const header: Seg[] = [
    { t: '  ' + fit('ADDRESS', addrW), color: C.accent2, bold: true },
    ...(barW ? [{ t: fit('USAGE', barW), color: C.accent2, bold: true }] : []),
    ...(pctW ? [{ t: fit('', pctW), color: C.accent2, bold: true }] : []),
    ...(sizeW ? [{ t: fit('USED / LIMIT', sizeW), color: C.accent2, bold: true }] : []),
    ...(msgW ? [{ t: fit('MSGS', msgW, 'right'), color: C.accent2, bold: true }] : []),
  ];

  const renderRow = (r: MbxRow, i: number) => {
    const selected = start + i === selRowIndex;
    if (r.type === 'domain') {
      const note = `${r.mailboxes} mailbox${r.mailboxes === 1 ? '' : 'es'}${r.aliases ? ` · ${r.aliases} alias${r.aliases === 1 ? '' : 'es'}` : ''}`;
      return (
        <Line
          key={`d-${r.domain}`}
          width={W}
          segs={[
            { t: `▾ ${r.domain}`, color: C.accent, bold: true },
            { t: `  ${note}`, dim: true },
          ]}
        />
      );
    }
    if (r.type === 'alias') {
      return (
        <Line
          key={`l-${r.alias.source}-${r.alias.destination}`}
          width={W}
          selected={selected}
          segs={[
            { t: '  ' },
            { t: fit(`↪ ${r.alias.source}  →  ${r.alias.destination}`, W - 2), color: C.pink },
          ]}
        />
      );
    }
    const u = usageOf(dashboard, r.account.email);
    const frac = u?.limitKb ? u.usedKb / u.limitKb : 0;
    const color = u?.limitKb ? usageColor(frac) : C.faint;
    const segs: Seg[] = [
      { t: selected ? '❯ ' : '  ', color: C.accent },
      { t: fit(r.account.email, addrW), bold: selected },
    ];
    if (barW) segs.push({ t: fit(u ? bar(frac, 10) : '', barW), color });
    if (pctW) segs.push({ t: fit(u ? (u.limitKb ? `${Math.round(frac * 100)}%` : '') : '', pctW - 1, 'right') + ' ', color });
    if (sizeW) {
      segs.push({
        t: fit(u ? `${formatKb(u.usedKb)}${u.limitKb ? ` / ${formatKb(u.limitKb)}` : ''}` : '—', sizeW - 1) + ' ',
        dim: !u,
      });
    }
    if (msgW) segs.push({ t: fit(u ? String(u.messages) : '', msgW, 'right'), dim: true });
    return <Line key={`a-${r.account.email}`} width={W} selected={selected} segs={segs} />;
  };

  const filterLabel = filterDomain ?? 'all domains';
  const right = `${dashboard.accounts.length} mailboxes · ${dashboard.aliases.length} aliases`;

  return (
    <Box width={width} height={height} gap={showDetail ? 1 : 0}>
      <Panel title={`Mailboxes · ${filterLabel}`} right={right} color={C.accent} width={listWidth} height={height}>
        {rows.length === 0 ? (
          <Empty>
            <Text dimColor>No mailboxes yet.</Text>
            <Text>
              Press <Text color={C.accent} bold>a</Text> to add one.
            </Text>
          </Empty>
        ) : (
          <>
            <Line segs={header} width={W} />
            {visible.map(renderRow)}
          </>
        )}
      </Panel>
      {showDetail && <MailboxDetail row={selRow} dashboard={dashboard} width={detailWidth} height={height} />}
    </Box>
  );
}

// ── Domains ──────────────────────────────────────────────────────────────────

const DNS_GLYPH: Record<DnsCheckItem['status'], { glyph: string; word: string; color?: string }> = {
  valid: { glyph: '●', word: 'ok', color: C.ok },
  invalid: { glyph: '▲', word: 'diff', color: C.warn },
  missing: { glyph: '○', word: 'miss', color: C.bad },
  unknown: { glyph: '?', word: '—', color: C.faint },
};

function dnsSeg(item: DnsCheckItem, width: number): Seg {
  const g = DNS_GLYPH[item.status];
  return { t: fit(`${g.glyph} ${g.word}`, width), color: g.color };
}

function DomainDetail({ domain, width, height }: { domain?: DomainInfo; width: number; height: number }) {
  const inner = width - 4;
  const lines: Array<Seg[]> = [];
  if (domain) {
    const checks: Array<[string, DnsCheckItem]> = [
      ['MX', domain.dnsStatus.mx],
      ['SPF', domain.dnsStatus.spf],
      [`DKIM  ${domain.dkimSelector}._domainkey`, domain.dnsStatus.dkim],
      ['DMARC', domain.dnsStatus.dmarc],
    ];
    for (const [name, item] of checks) {
      const g = DNS_GLYPH[item.status];
      lines.push([
        { t: `${g.glyph} `, color: g.color },
        { t: name, bold: true },
        { t: `  ${item.status}`, color: g.color },
      ]);
      const found = item.records.length > 0 ? item.records.join(', ') : '<none>';
      lines.push([{ t: '  found     ', dim: true }, { t: truncate(found, inner - 12) }]);
      if (item.expected && item.status !== 'valid') {
        lines.push([{ t: '  expected  ', dim: true }, { t: truncate(item.expected, inner - 12), color: C.warn }]);
      }
    }
    lines.push([]);
    lines.push([
      { t: 'DKIM key  ', dim: true },
      domain.dkimExists ? { t: '● generated', color: C.ok } : { t: '○ not generated  (press k)', color: C.bad },
    ]);
  }
  return (
    <Panel title={domain ? `DNS · ${domain.domain}` : 'DNS'} color={C.accent2} width={width} height={height}>
      {domain ? lines.slice(0, Math.max(1, height - 3)).map((segs, i) => <Line key={i} segs={segs} width={inner} />) : <Text dimColor>No domain selected.</Text>}
    </Panel>
  );
}

function ZonesPanel({ dashboard, width, height }: { dashboard: DashboardData; width: number; height: number }) {
  const inner = width - 4;
  const rows = Math.max(1, height - 3);
  const zones = dashboard.zones;
  const mail = (name: string) => dashboard.domains.some((d) => d.domain === name || d.domain.endsWith(`.${name}`));
  const title = `Cloudflare zones${zones ? ` (${zones.length})` : ''}${zones && dashboard.zonesError ? ' · stale' : ''}`;
  let body: React.ReactNode;
  if (!dashboard.cloudflareConfigured) body = <Text dimColor>Set CF_API_TOKEN in .env to list zones</Text>;
  else if (!zones) body = <Text color={dashboard.zonesError ? C.bad : undefined} dimColor={!dashboard.zonesError} wrap="truncate">{dashboard.zonesError ? `Error: ${dashboard.zonesError}` : 'Loading…'}</Text>;
  else if (zones.length === 0) body = <Text dimColor>No zones on this account</Text>;
  else {
    const shown = zones.length > rows ? zones.slice(0, rows - 1) : zones;
    body = (
      <>
        {shown.map((z) => (
          <Line
            key={z.name}
            width={inner}
            segs={[
              mail(z.name) ? { t: '● ', color: C.ok } : { t: '○ ', dim: true },
              { t: z.name, bold: mail(z.name), dim: !mail(z.name) },
              ...(z.status !== 'active' ? [{ t: ` (${z.status})`, color: C.warn }] : []),
            ]}
          />
        ))}
        {zones.length > shown.length && <Text dimColor>+{zones.length - shown.length} more</Text>}
      </>
    );
  }
  return (
    <Panel title={title} color={C.pink} width={width} height={height}>
      {body}
    </Panel>
  );
}

export function DomainsScreen({ dashboard, ctx, width, height, active, nav, patchNav, run }: ScreenProps) {
  const domains = dashboard.domains;
  const sel = clamp(nav.domSel, 0, Math.max(0, domains.length - 1));
  const current = domains[sel];

  useInput(
    (input, key) => {
      if (key.upArrow) patchNav({ domSel: clamp(sel - 1, 0, domains.length - 1) });
      else if (key.downArrow) patchNav({ domSel: clamp(sel + 1, 0, domains.length - 1) });
      else if (input === 'a') run(() => addDomainFlow(ctx));
      else if (input === 'x' && current) run(() => removeDomainFlow(ctx, current.domain));
      else if (input === 's' && current) run(() => syncDnsFlow(ctx, current.domain));
      else if (input === 'k' && current) run(() => dkimFlow(ctx, current.domain));
      else if (input === 'K' && current) run(() => dkimFlow(ctx, current.domain, true));
      else if (key.return && current) {
        run(async () => {
          const choice = await ui.select(current.domain, [
            { value: 'mailboxes', label: 'Show its mailboxes', icon: '✉', color: C.pink },
            { value: 'sync', label: 'Publish DNS to Cloudflare', icon: '☁', color: C.accent2 },
            { value: 'dkim', label: 'DKIM key', icon: '⚿', color: C.violet },
            { value: 'remove', label: 'Remove domain', icon: '✖', color: C.bad },
            { value: 'back', label: 'Back', icon: '←', color: C.muted },
          ]);
          if (isCancel(choice) || choice === 'back') return;
          if (choice === 'mailboxes') patchNav({ screen: 'mailboxes', mbxFilter: sel + 1, mbxSel: 0 });
          else if (choice === 'sync') await syncDnsFlow(ctx, current.domain);
          else if (choice === 'dkim') await dkimFlow(ctx, current.domain);
          else if (choice === 'remove') await removeDomainFlow(ctx, current.domain);
        });
      }
    },
    { isActive: active }
  );

  const wide = width >= 104;
  const tableWidth = wide ? Math.floor(width * 0.56) : width;
  const sideWidth = width - tableWidth - 1;
  const W = tableWidth - 4;
  const showMbx = W >= 56;
  const fixed = (showMbx ? 11 : 0) + 7 * 4;
  const domW = Math.max(12, W - 2 - fixed);
  const rowsAvail = Math.max(1, height - 3);

  // Narrow terminals stack the DNS detail under the table.
  const detailH = wide ? 0 : clamp(Math.floor(height * 0.5), 9, 13);
  const tableH = wide ? height : Math.max(5, height - detailH);
  const tableRows = Math.max(1, tableH - 3);
  const start = windowStart(sel, domains.length, tableRows - 1);

  const hdr: Seg[] = [
    { t: '  ' + fit('DOMAIN', domW), color: C.accent2, bold: true },
    ...(showMbx ? [{ t: fit('MBX', 5), color: C.accent2, bold: true }, { t: fit('KEY', 6), color: C.accent2, bold: true }] : []),
    { t: fit('MX', 7), color: C.accent2, bold: true },
    { t: fit('SPF', 7), color: C.accent2, bold: true },
    { t: fit('DKIM', 7), color: C.accent2, bold: true },
    { t: fit('DMARC', 7), color: C.accent2, bold: true },
  ];

  const table = (
    <Panel
      title="Domains"
      right={domains.length ? `${sel + 1}/${domains.length}` : ''}
      color={C.accent}
      width={tableWidth}
      height={tableH}
    >
      {domains.length === 0 ? (
        <Empty>
          <Text dimColor>No domains registered.</Text>
          <Text>
            Press <Text color={C.accent} bold>a</Text> to add one.
          </Text>
        </Empty>
      ) : (
        <>
          <Line segs={hdr} width={W} />
          {domains.slice(start, start + tableRows - 1).map((d, i) => {
            const selected = start + i === sel;
            return (
              <Line
                key={d.domain}
                width={W}
                selected={selected}
                segs={[
                  { t: selected ? '❯ ' : '  ', color: C.accent },
                  { t: fit(d.domain, domW), bold: true },
                  ...(showMbx
                    ? [
                        { t: fit(String(d.mailboxCount), 5) },
                        d.dkimExists ? { t: fit('● yes', 6), color: C.ok } : { t: fit('○ no', 6), color: C.bad },
                      ]
                    : []),
                  dnsSeg(d.dnsStatus.mx, 7),
                  dnsSeg(d.dnsStatus.spf, 7),
                  dnsSeg(d.dnsStatus.dkim, 7),
                  dnsSeg(d.dnsStatus.dmarc, 7),
                ]}
              />
            );
          })}
        </>
      )}
    </Panel>
  );

  if (wide) {
    const detailHeight = clamp(17, 10, height - 5);
    return (
      <Box width={width} height={height} gap={1}>
        {table}
        <Box flexDirection="column" width={sideWidth} height={height}>
          <DomainDetail domain={current} width={sideWidth} height={detailHeight} />
          <ZonesPanel dashboard={dashboard} width={sideWidth} height={height - detailHeight} />
        </Box>
      </Box>
    );
  }
  return (
    <Box width={width} height={height} flexDirection="column">
      {table}
      <DomainDetail domain={current} width={width} height={detailH} />
    </Box>
  );
}

// ── Tools ────────────────────────────────────────────────────────────────────

interface ToolSpec {
  key: string;
  label: string;
  icon: string;
  color: string;
  hint: string;
  run: () => Promise<void>;
}

export const TOOLS: ToolSpec[] = [
  { key: 'queue', label: 'Mail queue', icon: '▤', color: C.warn, hint: 'retry / purge', run: toolMailQueue },
  { key: 'log', label: 'Delivery log', icon: '≡', color: C.accent, hint: 'sent / bounced', run: toolDeliveryLog },
  { key: 'quotas', label: 'Mailbox usage', icon: '▰', color: C.ok, hint: 'quota bars', run: toolQuotas },
  { key: 'clients', label: 'Connected clients', icon: '◉', color: '#2dd4bf', hint: 'IMAP/POP', run: toolClients },
  { key: 'f2b', label: 'fail2ban', icon: '⊘', color: C.bad, hint: 'bans', run: toolFail2ban },
  { key: 'cert', label: 'TLS certificate', icon: '⚿', color: C.violet, hint: 'expiry', run: toolCertificate },
  { key: 'path', label: 'Mail path', icon: '⇄', color: C.accent2, hint: 'in & out', run: toolPipeline },
  { key: 'postmark', label: 'Postmark stats', icon: '✉', color: C.pink, hint: 'bounces', run: toolPostmark },
  { key: 'test', label: 'Send test email', icon: '➤', color: C.ok, hint: '', run: toolSendTest },
  { key: 'container', label: 'Mail server container', icon: '▣', color: C.accent, hint: 'start / stop', run: actionDockerControl },
];

export function ToolsScreen({
  state,
  width,
  height,
  active,
  nav,
  patchNav,
  run,
}: ScreenProps & { state: UiState }) {
  const sel = clamp(nav.toolSel, 0, TOOLS.length - 1);
  const listWidth = width >= 100 ? 44 : 30;
  const outWidth = width - listWidth - 1;
  const rows = Math.max(1, height - 3);
  const inner = outWidth - 4;
  const { output, outputTitle } = state;
  const { shown, above, below } = windowLines(output as OutputLine[], rows - 1, inner, nav.outScroll);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') patchNav({ toolSel: clamp(sel - 1, 0, TOOLS.length - 1) });
      else if (key.downArrow || input === 'j') patchNav({ toolSel: clamp(sel + 1, 0, TOOLS.length - 1) });
      else if (key.pageUp) patchNav({ outScroll: Math.min(Math.max(0, output.length - 1), nav.outScroll + Math.ceil(rows / 2)) });
      else if (key.pageDown) patchNav({ outScroll: Math.max(0, nav.outScroll - Math.ceil(rows / 2)) });
      else if (key.return) {
        const tool = TOOLS[sel];
        patchNav({ outScroll: 0 });
        run(async () => {
          ui.begin(tool.label);
          await tool.run();
        });
      }
    },
    { isActive: active }
  );

  return (
    <Box width={width} height={height} gap={1}>
      <Panel title="Tools" color={C.accent} width={listWidth} height={height}>
        {TOOLS.slice(windowStart(sel, TOOLS.length, rows), windowStart(sel, TOOLS.length, rows) + rows).map((t, n) => {
          const i = windowStart(sel, TOOLS.length, rows) + n;
          const selected = i === sel;
          return (
            <Line
              key={t.key}
              width={listWidth - 4}
              selected={selected}
              segs={[
                { t: selected ? '❯ ' : '  ', color: C.accent },
                { t: `${t.icon} `, color: t.color },
                { t: t.label, bold: selected },
                ...(t.hint && listWidth >= 44 ? [{ t: `  ${t.hint}`, dim: true }] : []),
              ]}
            />
          );
        })}
      </Panel>
      <Panel
        title={outputTitle ?? 'Output'}
        right={above > 0 || below > 0 ? `↑↓ pgup/pgdn · ${above} above` : undefined}
        color={C.violet}
        width={outWidth}
        height={height}
      >
        {output.length === 0 ? (
          <Empty>
            <Text dimColor>Pick a tool and press enter.</Text>
          </Empty>
        ) : (
          <>
            {above > 0 && <Text dimColor>… {above} earlier line(s)</Text>}
            {shown.map((l, i) => (
              <OutputLineView key={above + i} line={l} />
            ))}
          </>
        )}
      </Panel>
    </Box>
  );
}
