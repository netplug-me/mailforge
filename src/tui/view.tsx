import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import stringWidth from 'string-width';
import { getAppConfig } from '../config.js';
import { DnsCheckItem, DomainInfo } from '../types.js';
import { CANCEL, DashboardData, Health, OutputLine, Prompt, ui } from './ui.js';

// ── Palette ──────────────────────────────────────────────────────────────────
// Green / yellow / red stay reserved for ok / diff / missing; everything else is decoration.

export const PALETTE = {
  header: '#38bdf8',
  zones: '#f472b6',
  table: '#818cf8',
  menu: '#2dd4bf',
  output: '#a78bfa',
  accent: '#fbbf24',
  gradient: ['#38bdf8', '#818cf8', '#f472b6'],
} as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function gradientAt(stops: readonly string[], t: number): string {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * (x - i)));
  return '#' + mix.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** One <Text> per character, blended across the palette's gradient stops. */
function Gradient({ text, bold = true }: { text: string; bold?: boolean }) {
  const chars = [...text];
  return (
    <Text bold={bold}>
      {chars.map((c, i) => (
        <Text key={i} color={gradientAt(PALETTE.gradient, chars.length > 1 ? i / (chars.length - 1) : 0)}>
          {c}
        </Text>
      ))}
    </Text>
  );
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

// ── Header ───────────────────────────────────────────────────────────────────

function KeyValue({ label, labelWidth = 16, children }: { label: string; labelWidth?: number; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={labelWidth} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1}>{children}</Box>
    </Box>
  );
}

function ContainerBadge({ status }: { status: DashboardData['containerStatus'] }) {
  if (status === 'running') return <Text color="green" bold>● running</Text>;
  if (status === 'exited') return <Text color="yellow" bold>▲ exited</Text>;
  if (status === 'stopped') return <Text color="red" bold>○ stopped</Text>;
  return <Text color="red" bold>○ not found</Text>;
}

/** ● running · ▲ present but not running · ○ absent. */
function StageDot({ label, state }: { label: string; state?: string }) {
  const color = state === 'running' ? 'green' : state ? 'yellow' : 'red';
  const glyph = state === 'running' ? '●' : state ? '▲' : '○';
  return (
    <Text>
      <Text color={color}>{glyph}</Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

function certColor(days: number): string {
  return days < 14 ? 'red' : days < 30 ? 'yellow' : 'green';
}

function CertBadge({ health }: { health?: Health }) {
  if (health?.certDays === undefined) return <Text dimColor>unknown</Text>;
  return (
    <Text color={certColor(health.certDays)} bold>
      {health.certDays}d left
    </Text>
  );
}

function PathBadges({ health }: { health?: Health }) {
  return (
    <Text wrap="truncate">
      <StageDot label="bridge" state={health?.bridge} />
      <Text> </Text>
      <StageDot label="tunnel" state={health?.tunnel} />
      <Text> </Text>
      <StageDot label="relay" state={health?.relay ? 'running' : undefined} />
    </Text>
  );
}

function Header({ dashboard, refreshing }: { dashboard: DashboardData; refreshing: boolean }) {
  const config = getAppConfig();
  const time = dashboard.refreshedAt?.toLocaleTimeString([], { hour12: false });
  return (
    <Box borderStyle="round" borderColor={PALETTE.header} flexDirection="column" paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Gradient text="✉  Mail Server Manager" />
        {refreshing ? (
          <Text color="yellow">
            <Spinner type="dots" /> refreshing
          </Text>
        ) : (
          <Text dimColor>{time ? `updated ${time}` : ''}</Text>
        )}
      </Box>
      <Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <KeyValue label="Primary domain">
            <Text bold wrap="truncate-middle">{config.primaryDomain}</Text>
          </KeyValue>
          <KeyValue label="MX host">
            <Text bold wrap="truncate-middle">{config.mxHost}</Text>
          </KeyValue>
          <KeyValue label="DKIM selector">
            <Text bold>{config.dkimSelector}</Text>
          </KeyValue>
          <KeyValue label="TLS certificate">
            <CertBadge health={dashboard.health} />
          </KeyValue>
        </Box>
        <Box flexDirection="column" flexShrink={0} marginLeft={2}>
          <KeyValue label="Container" labelWidth={12}>
            <ContainerBadge status={dashboard.containerStatus} />
          </KeyValue>
          <KeyValue label="Cloudflare" labelWidth={12}>
            {dashboard.cloudflareConfigured ? (
              <Text color="green">● configured</Text>
            ) : (
              <Text dimColor>○ not set (CF_API_TOKEN)</Text>
            )}
          </KeyValue>
          <KeyValue label="Domains" labelWidth={12}>
            <Text bold color={PALETTE.accent}>
              {dashboard.domains.length}
            </Text>
          </KeyValue>
          <KeyValue label="Mail path" labelWidth={12}>
            <PathBadges health={dashboard.health} />
          </KeyValue>
        </Box>
      </Box>
    </Box>
  );
}

// ── Domain table ─────────────────────────────────────────────────────────────

function Cell({ width, children }: { width: number; children: React.ReactNode }) {
  // paddingRight keeps a gap even when the content is truncated to fit.
  return (
    <Box width={width} flexShrink={0} paddingRight={1}>
      {children}
    </Box>
  );
}

function DnsCell({ item }: { item: DnsCheckItem }) {
  switch (item.status) {
    case 'valid':
      return <Text color="green">● ok</Text>;
    case 'invalid':
      return <Text color="yellow">▲ diff</Text>;
    case 'missing':
      return <Text color="red">○ miss</Text>;
    default:
      return <Text dimColor>? —</Text>;
  }
}

interface Column {
  key: string;
  header: string;
  width: number;
  render: (d: DomainInfo) => React.ReactNode;
}

const COLUMNS: Column[] = [
  {
    key: 'type',
    header: 'TYPE',
    width: 9,
    render: (d) => (d.isPrimary ? <Text color={PALETTE.accent}>primary</Text> : <Text dimColor>virtual</Text>),
  },
  { key: 'mbx', header: 'MBX', width: 5, render: (d) => <Text>{d.mailboxCount}</Text> },
  {
    key: 'dkim',
    header: 'DKIM',
    width: 7,
    render: (d) => (d.dkimExists ? <Text color="green">● yes</Text> : <Text color="red">○ no</Text>),
  },
  { key: 'mx', header: 'MX', width: 10, render: (d) => <DnsCell item={d.dnsStatus.mx} /> },
  { key: 'spf', header: 'SPF', width: 10, render: (d) => <DnsCell item={d.dnsStatus.spf} /> },
  { key: 'dkimdns', header: 'DKIM DNS', width: 10, render: (d) => <DnsCell item={d.dnsStatus.dkim} /> },
  { key: 'dmarc', header: 'DMARC', width: 10, render: (d) => <DnsCell item={d.dnsStatus.dmarc} /> },
];

/** Dropped first, in this order, when the terminal is too narrow for every column. */
const OPTIONAL_COLUMNS = ['type', 'mbx'];
const MIN_DOMAIN_WIDTH = 12;

function DomainTable({
  domains,
  refreshing,
  columns,
}: {
  domains: DomainInfo[];
  refreshing: boolean;
  columns: number;
}) {
  // Border + padding take 4 columns. The domain column gets what's left (truncated if
  // it must), so the row never overflows the box.
  const inner = columns - 4;
  let cols = COLUMNS;
  for (const key of OPTIONAL_COLUMNS) {
    if (inner - cols.reduce((sum, c) => sum + c.width, 0) >= MIN_DOMAIN_WIDTH) break;
    cols = cols.filter((c) => c.key !== key);
  }
  const fixed = cols.reduce((sum, c) => sum + c.width, 0);
  const wanted = Math.max(8, ...domains.map((d) => stringWidth(d.domain))) + 2;
  const domainWidth = Math.max(8, Math.min(wanted, inner - fixed));

  return (
    <Box borderStyle="round" borderColor={PALETTE.table} flexDirection="column" paddingX={1}>
      <Box>
        <Cell width={domainWidth}>
          <Text bold color={PALETTE.table} wrap="truncate">
            DOMAIN
          </Text>
        </Cell>
        {cols.map((c) => (
          <Cell key={c.key} width={c.width}>
            <Text bold color={PALETTE.table} wrap="truncate">
              {c.header}
            </Text>
          </Cell>
        ))}
      </Box>
      {domains.length === 0 && (
        <Text dimColor>{refreshing ? 'Loading domains…' : 'No domains registered.'}</Text>
      )}
      {domains.map((d) => (
        <Box key={d.domain}>
          <Cell width={domainWidth}>
            <Text bold wrap="truncate-middle">
              {d.domain}
            </Text>
          </Cell>
          {cols.map((c) => (
            <Cell key={c.key} width={c.width}>
              {c.render(d)}
            </Cell>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ── Output panel ─────────────────────────────────────────────────────────────

const PREFIX: Record<OutputLine['kind'], string> = {
  success: '✔ ',
  error: '✖ ',
  warn: '! ',
  info: '› ',
  text: '  ',
  heading: '',
  raw: '',
};

const COLOR: Partial<Record<OutputLine['kind'], string>> = {
  success: 'green',
  error: 'red',
  warn: 'yellow',
  info: 'cyan',
};

/** Terminal rows a line occupies once wrapped to `width`. */
function rowsFor(line: OutputLine, width: number): number {
  const w = stringWidth(PREFIX[line.kind] + line.text);
  return Math.max(1, Math.ceil(w / Math.max(1, width)));
}

/** The newest lines that fit in `rows` terminal rows, plus how many were dropped. */
function tailThatFits(lines: OutputLine[], rows: number, width: number) {
  let used = 0;
  let start = lines.length;
  while (start > 0 && used + rowsFor(lines[start - 1], width) <= rows) {
    used += rowsFor(lines[--start], width);
  }
  // Make room for the "earlier lines" notice.
  if (start > 0 && used + 1 > rows && lines.length - start > 1) start++;
  return { shown: lines.slice(start), hidden: start };
}

function OutputLineView({ line }: { line: OutputLine }) {
  if (line.kind === 'heading') {
    return (
      <Text bold color={PALETTE.output}>
        {line.text}
      </Text>
    );
  }
  if (line.kind === 'raw') return <Text color={line.color}>{line.text}</Text>;
  return (
    <Text>
      <Text color={COLOR[line.kind]}>{PREFIX[line.kind]}</Text>
      <Text color={line.color ?? (line.kind === 'error' ? 'red' : undefined)}>{line.text}</Text>
    </Text>
  );
}

function OutputPanel({
  title,
  lines,
  width,
  height,
}: {
  title?: string;
  lines: OutputLine[];
  width: number;
  height: number;
}) {
  // Border (2) + title (1). The frame must stay shorter than the terminal or Ink
  // falls back to clear-and-redraw on every update, so the panel has a fixed height.
  const inner = Math.max(1, height - 3);
  const { shown, hidden } = tailThatFits(lines, inner, width - 4);
  return (
    <Box
      borderStyle="round"
      borderColor={PALETTE.output}
      flexDirection="column"
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
    >
      <Text bold color={PALETTE.output} wrap="truncate">
        {title ?? 'Output'}
      </Text>
      {!title && <Text dimColor>Results of actions appear here.</Text>}
      {hidden > 0 && <Text dimColor>… {hidden} earlier line(s) not shown</Text>}
      {shown.map((l, i) => (
        <OutputLineView key={hidden + i} line={l} />
      ))}
    </Box>
  );
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function SelectPrompt({ prompt, limit }: { prompt: Extract<Prompt, { kind: 'select' }>; limit: number }) {
  useInput((_input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
  });
  // The item component only receives `label`, so it carries the option index.
  const items = prompt.options.map((o, i) => ({ key: String(i), label: String(i), value: i }));
  return (
    <Box flexDirection="column">
      <Text bold color={PALETTE.menu} wrap="truncate">
        {prompt.message}
      </Text>
      <SelectInput
        items={items}
        limit={limit}
        onSelect={(item) => prompt.resolve(prompt.options[item.value].value)}
        itemComponent={({ isSelected, label }) => {
          const o = prompt.options[Number(label)];
          return (
            <Text wrap="truncate">
              {o.icon && <Text color={o.color ?? PALETTE.menu}>{o.icon} </Text>}
              <Text bold={isSelected} color={isSelected ? PALETTE.menu : undefined}>
                {o.label}
              </Text>
              {o.hint && <Text dimColor> {o.hint}</Text>}
            </Text>
          );
        }}
      />
    </Box>
  );
}

function TextPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'text' }> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  useInput((_input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
  });
  return (
    <Box flexDirection="column">
      <Text bold>{prompt.message}</Text>
      <Box>
        <Text color={PALETTE.menu}>› </Text>
        <TextInput
          value={value}
          placeholder={prompt.placeholder}
          mask={prompt.mask ? '*' : undefined}
          onChange={(v) => {
            setValue(v);
            setError(undefined);
          }}
          onSubmit={(v) => {
            const err = prompt.validate?.(v);
            if (err) setError(err);
            else prompt.resolve(v);
          }}
        />
      </Box>
      {error && <Text color="red">✖ {error}</Text>}
    </Box>
  );
}

function ConfirmPrompt({ prompt }: { prompt: Extract<Prompt, { kind: 'confirm' }> }) {
  const [yes, setYes] = useState(prompt.initial);
  useInput((input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
    else if (key.return) prompt.resolve(yes);
    else if (input.toLowerCase() === 'y') prompt.resolve(true);
    else if (input.toLowerCase() === 'n') prompt.resolve(false);
    else if (key.leftArrow || key.rightArrow || key.tab) setYes((v) => !v);
  });
  return (
    <Box flexDirection="column">
      <Text bold color={prompt.danger ? 'red' : undefined}>
        {prompt.message}
      </Text>
      <Box marginTop={1}>
        <Text inverse={yes} color={yes ? PALETTE.menu : undefined}>
          {' Yes '}
        </Text>
        <Text> </Text>
        <Text inverse={!yes} color={!yes ? PALETTE.menu : undefined}>
          {' No '}
        </Text>
      </Box>
    </Box>
  );
}

function PromptPanel({
  prompt,
  promptId,
  busy,
  width,
  height,
}: {
  prompt?: Prompt;
  promptId: number;
  busy?: string;
  width: number;
  height: number;
}) {
  // Border (2) + select message (1).
  const limit = Math.max(3, height - 3);
  return (
    <Box
      borderStyle="round"
      borderColor={prompt?.kind === 'confirm' && prompt.danger ? 'red' : PALETTE.menu}
      flexDirection="column"
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
    >
      {busy ? (
        <Text color="yellow">
          <Spinner type="dots" /> {busy}
        </Text>
      ) : prompt?.kind === 'select' ? (
        <SelectPrompt key={promptId} prompt={prompt} limit={limit} />
      ) : prompt?.kind === 'text' ? (
        <TextPrompt key={promptId} prompt={prompt} />
      ) : prompt?.kind === 'confirm' ? (
        <ConfirmPrompt key={promptId} prompt={prompt} />
      ) : null}
    </Box>
  );
}

const HINTS: Record<Prompt['kind'], string> = {
  select: '↑↓ move · enter select · esc back · ctrl+c quit',
  text: 'enter submit · esc cancel',
  confirm: 'y/n · ←→ toggle · enter confirm · esc cancel',
};

// ── Compact header (short terminals) ─────────────────────────────────────────

function CompactHeader({ dashboard, refreshing }: { dashboard: DashboardData; refreshing: boolean }) {
  const config = getAppConfig();
  return (
    <Box borderStyle="round" borderColor={PALETTE.header} paddingX={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Gradient text={config.primaryDomain} />
        <Text dimColor> · </Text>
        <ContainerBadge status={dashboard.containerStatus} />
        <Text dimColor> · cf </Text>
        {dashboard.cloudflareConfigured ? <Text color="green">●</Text> : <Text dimColor>○</Text>}
        <Text dimColor> · </Text>
        <PathBadges health={dashboard.health} />
        {dashboard.health?.certDays !== undefined && (
          <Text color={certColor(dashboard.health.certDays)}> · tls {dashboard.health.certDays}d</Text>
        )}
      </Text>
      {refreshing ? (
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
      ) : null}
    </Box>
  );
}

// ── Cloudflare zones ─────────────────────────────────────────────────────────

interface ZoneItem {
  name: string;
  status: string;
  /** The mail server already handles this zone or a subdomain of it. */
  mail: boolean;
}

function zoneItems(dashboard: DashboardData): ZoneItem[] {
  return (dashboard.zones ?? []).map((z) => ({
    name: z.name,
    status: z.status,
    mail: dashboard.domains.some((d) => d.domain === z.name || d.domain.endsWith(`.${z.name}`)),
  }));
}

/** Text shown instead of the list when there is no list to show. */
function zonesMessage(dashboard: DashboardData): string | undefined {
  if (!dashboard.cloudflareConfigured) return 'Set CF_API_TOKEN to list zones';
  if (!dashboard.zones) return dashboard.zonesError ? `Error: ${dashboard.zonesError}` : 'Loading…';
  if (dashboard.zones.length === 0) return 'No zones on this account';
}

function zonesTitle(dashboard: DashboardData): string {
  const count = dashboard.zones ? ` (${dashboard.zones.length})` : '';
  // A failed refresh keeps the previous list on screen.
  const stale = dashboard.zones && dashboard.zonesError ? ' · stale' : '';
  return `Cloudflare zones${count}${stale}`;
}

function zoneLabel(z: ZoneItem): string {
  return z.status === 'active' ? z.name : `${z.name} (${z.status})`;
}

function ZoneEntry({ zone }: { zone: ZoneItem }) {
  return (
    <Text wrap="truncate-middle">
      {zone.mail ? <Text color="green">● </Text> : <Text dimColor>○ </Text>}
      <Text bold={zone.mail} dimColor={!zone.mail}>
        {zone.name}
      </Text>
      {zone.status !== 'active' && <Text color="yellow"> ({zone.status})</Text>}
    </Text>
  );
}

const MAX_ZONES_BESIDE_HEADER = 8;

/** Content rows of the zones column (title + entries or message). */
function zonesColumnRows(dashboard: DashboardData): number {
  if (zonesMessage(dashboard)) return 2;
  const n = dashboard.zones!.length;
  return 1 + Math.min(n, MAX_ZONES_BESIDE_HEADER) + (n > MAX_ZONES_BESIDE_HEADER ? 1 : 0);
}

function zonesColumnWidth(dashboard: DashboardData): number {
  const longest = Math.max(stringWidth(zonesTitle(dashboard)), ...zoneItems(dashboard).map((z) => 2 + stringWidth(zoneLabel(z))));
  return Math.min(40, Math.max(26, longest + 4));
}

/** Zones listed one per line; sits to the right of the full header. */
function ZonesColumn({ dashboard, width }: { dashboard: DashboardData; width: number }) {
  const message = zonesMessage(dashboard);
  const items = zoneItems(dashboard);
  const shown = items.slice(0, MAX_ZONES_BESIDE_HEADER);
  return (
    <Box borderStyle="round" borderColor={PALETTE.zones} flexDirection="column" paddingX={1} width={width} flexShrink={0}>
      <Text bold color={PALETTE.zones} wrap="truncate">
        {zonesTitle(dashboard)}
      </Text>
      {message ? (
        <Text dimColor={!dashboard.zonesError} color={dashboard.zonesError ? 'red' : undefined} wrap="truncate">
          {message}
        </Text>
      ) : (
        <>
          {shown.map((z) => (
            <ZoneEntry key={z.name} zone={z} />
          ))}
          {items.length > shown.length && <Text dimColor>+{items.length - shown.length} more</Text>}
        </>
      )}
    </Box>
  );
}

type Chip =
  | { kind: 'title'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'more'; text: string }
  | { kind: 'zone'; zone: ZoneItem };

const chipText = (c: Chip) => (c.kind === 'zone' ? `○ ${zoneLabel(c.zone)}` : c.text);
const CHIP_GAP = 3;

/**
 * Greedy line packing so the box height is known before rendering. Past `maxLines`
 * the remaining zones collapse into a "+N more" chip.
 */
function packZoneChips(dashboard: DashboardData, width: number, maxLines: number): Chip[][] {
  const message = zonesMessage(dashboard);
  const chips: Chip[] = [
    { kind: 'title', text: zonesTitle(dashboard) },
    ...(message ? [{ kind: 'message', text: message } as Chip] : zoneItems(dashboard).map((zone) => ({ kind: 'zone', zone }) as Chip)),
  ];
  const lines: Chip[][] = [];
  let line: Chip[] = [];
  let used = 0;
  for (const chip of chips) {
    const w = stringWidth(chipText(chip));
    if (line.length > 0 && used + CHIP_GAP + w > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length > 0 ? CHIP_GAP : 0) + w;
    line.push(chip);
  }
  if (line.length) lines.push(line);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const last = kept[kept.length - 1];
  const zoneCount = chips.filter((c) => c.kind === 'zone').length;
  const hiddenCount = () => zoneCount - kept.flat().filter((c) => c.kind === 'zone').length;
  const lineWidth = (l: Chip[]) => l.reduce((sum, c, i) => sum + (i ? CHIP_GAP : 0) + stringWidth(chipText(c)), 0);
  const moreChip = (): Chip => ({ kind: 'more', text: `+${hiddenCount()} more` });
  while (last.length > 1 && lineWidth([...last, moreChip()]) > width) last.pop();
  last.push(moreChip());
  return kept;
}

/** Zones listed inline and wrapped; used under the header on narrow or short terminals. */
function ZonesInline({ lines }: { lines: Chip[][] }) {
  return (
    <Box borderStyle="round" borderColor={PALETTE.zones} flexDirection="column" paddingX={1}>
      {lines.map((line, i) => (
        <Box key={i} gap={CHIP_GAP}>
          {line.map((chip, j) =>
            chip.kind === 'title' ? (
              <Text key={j} bold color={PALETTE.zones} wrap="truncate">
                {chip.text}
              </Text>
            ) : chip.kind === 'message' || chip.kind === 'more' ? (
              <Text key={j} dimColor wrap="truncate">
                {chip.text}
              </Text>
            ) : (
              <ZoneEntry key={j} zone={chip.zone} />
            )
          )}
        </Box>
      ))}
    </Box>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

const SIDE_BY_SIDE_MIN_COLUMNS = 70;
/** Output rows (inside the border) kept visible when panels are stacked. */
const MIN_STACKED_OUTPUT_ROWS = 6;
const COMPACT_HEADER_MAX_ROWS = 32;
/** Title plus four key/value rows in the full header. */
const HEADER_CONTENT_ROWS = 5;
const ZONES_BESIDE_HEADER_MIN_COLUMNS = 110;

export function App() {
  const state = useSyncExternalStore(ui.subscribe, ui.getState);
  const { columns, rows } = useTerminalSize();
  const { prompt, busy, dashboard, refreshing } = state;

  const compact = rows < COMPACT_HEADER_MAX_ROWS;
  // Zones go beside the full header when there is room, otherwise in a wrapped box below it.
  const zonesBeside = !compact && columns >= ZONES_BESIDE_HEADER_MIN_COLUMNS;
  const zonesWidth = zonesColumnWidth(dashboard);
  // Short terminals cap the wrapped list so the menu and output keep their room.
  const zoneLines = zonesBeside ? [] : packZoneChips(dashboard, columns - 4, compact ? 2 : 4);
  const headerRows = zonesBeside
    ? 2 + Math.max(HEADER_CONTENT_ROWS, zonesColumnRows(dashboard))
    : (compact ? 3 : 2 + HEADER_CONTENT_ROWS) + 2 + zoneLines.length;
  const tableRows = 3 + Math.max(1, dashboard.domains.length);
  // Header, table, footer (1) and one spare row so the frame never fills the terminal.
  const body = Math.max(8, rows - headerRows - tableRows - 1 - 1);

  const sideBySide = columns >= SIDE_BY_SIDE_MIN_COLUMNS;
  const promptWidth = sideBySide ? Math.min(46, Math.max(32, Math.floor(columns * 0.35))) : columns;
  // Stacked: the menu scrolls rather than squeezing the output panel below a readable size.
  const promptHeight = sideBySide
    ? body
    : Math.max(5, Math.min(body - (MIN_STACKED_OUTPUT_ROWS + 3), promptRowsFor(prompt, busy) + 2));
  const outputWidth = sideBySide ? columns - promptWidth - 1 : columns;
  const outputHeight = sideBySide ? body : body - promptHeight;

  const hint = busy ? 'working…' : prompt ? HINTS[prompt.kind] : '';

  return (
    <Box flexDirection="column" width={columns}>
      {zonesBeside ? (
        <Box gap={1}>
          <Header dashboard={dashboard} refreshing={refreshing} />
          <ZonesColumn dashboard={dashboard} width={zonesWidth} />
        </Box>
      ) : (
        <>
          {compact ? (
            <CompactHeader dashboard={dashboard} refreshing={refreshing} />
          ) : (
            <Header dashboard={dashboard} refreshing={refreshing} />
          )}
          <ZonesInline lines={zoneLines} />
        </>
      )}
      <DomainTable domains={dashboard.domains} refreshing={refreshing} columns={columns} />

      <Box flexDirection={sideBySide ? 'row' : 'column-reverse'} gap={sideBySide ? 1 : 0}>
        <PromptPanel prompt={prompt} promptId={state.promptId} busy={busy} width={promptWidth} height={promptHeight} />
        <OutputPanel title={state.outputTitle} lines={state.output} width={outputWidth} height={outputHeight} />
      </Box>

      <Box justifyContent="space-between" width={columns}>
        <Text dimColor wrap="truncate">
          {' '}
          {hint}
        </Text>
        {columns >= 80 && (
          <Text>
            <Text color="green">● ok</Text> <Text color="red">○ miss</Text> <Text color="yellow">▲ diff</Text>{' '}
            <Text dimColor>? unknown </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}

function promptRowsFor(prompt: Prompt | undefined, busy: string | undefined): number {
  if (busy || !prompt) return 1;
  if (prompt.kind === 'select') return 1 + prompt.options.length;
  if (prompt.kind === 'text') return 3;
  return 3;
}
