import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import stringWidth from 'string-width';
import { getAppConfig } from '../config.js';
import { DnsCheckItem, DomainInfo } from '../types.js';
import { CANCEL, DashboardData, OutputLine, Prompt, ui } from './ui.js';

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

function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Box width={17} flexShrink={0}>
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

function Header({ dashboard, refreshing }: { dashboard: DashboardData; refreshing: boolean }) {
  const config = getAppConfig();
  const time = dashboard.refreshedAt?.toLocaleTimeString([], { hour12: false });
  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Mail Server Manager
        </Text>
        {refreshing ? (
          <Text color="yellow">
            <Spinner type="dots" /> refreshing
          </Text>
        ) : (
          <Text dimColor>{time ? `updated ${time}` : ''}</Text>
        )}
      </Box>
      <Box>
        <Box flexDirection="column" width="50%">
          <KeyValue label="Primary domain">
            <Text bold>{config.primaryDomain}</Text>
          </KeyValue>
          <KeyValue label="MX host">
            <Text bold>{config.mxHost}</Text>
          </KeyValue>
          <KeyValue label="DKIM selector">
            <Text bold>{config.dkimSelector}</Text>
          </KeyValue>
        </Box>
        <Box flexDirection="column" width="50%">
          <KeyValue label="Container">
            <ContainerBadge status={dashboard.containerStatus} />
          </KeyValue>
          <KeyValue label="Cloudflare">
            {dashboard.cloudflareConfigured ? (
              <Text color="green">● configured</Text>
            ) : (
              <Text dimColor>○ not set (CF_API_TOKEN)</Text>
            )}
          </KeyValue>
          <KeyValue label="Domains">
            <Text bold>{dashboard.domains.length}</Text>
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

const COLS = { type: 9, mbx: 5, dkim: 7, dns: 10 };
const FIXED_COLS = COLS.type + COLS.mbx + COLS.dkim + 4 * COLS.dns;

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
  const wanted = Math.max(8, ...domains.map((d) => stringWidth(d.domain))) + 2;
  const domainWidth = Math.max(8, Math.min(wanted, columns - 4 - FIXED_COLS));
  const headers: [string, number][] = [
    ['DOMAIN', domainWidth],
    ['TYPE', COLS.type],
    ['MBX', COLS.mbx],
    ['DKIM', COLS.dkim],
    ['MX', COLS.dns],
    ['SPF', COLS.dns],
    ['DKIM DNS', COLS.dns],
    ['DMARC', COLS.dns],
  ];
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="column" paddingX={1}>
      <Box>
        {headers.map(([h, w]) => (
          <Cell key={h} width={w}>
            <Text bold color="cyan" wrap="truncate">
              {h}
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
          <Cell width={COLS.type}>
            {d.isPrimary ? <Text color="blue">primary</Text> : <Text dimColor>virtual</Text>}
          </Cell>
          <Cell width={COLS.mbx}>
            <Text>{d.mailboxCount}</Text>
          </Cell>
          <Cell width={COLS.dkim}>
            {d.dkimExists ? <Text color="green">● yes</Text> : <Text color="red">○ no</Text>}
          </Cell>
          <Cell width={COLS.dns}>
            <DnsCell item={d.dnsStatus.mx} />
          </Cell>
          <Cell width={COLS.dns}>
            <DnsCell item={d.dnsStatus.spf} />
          </Cell>
          <Cell width={COLS.dns}>
            <DnsCell item={d.dnsStatus.dkim} />
          </Cell>
          <Cell width={COLS.dns}>
            <DnsCell item={d.dnsStatus.dmarc} />
          </Cell>
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
  if (start > 0 && start < lines.length && used + 1 > rows) start++;
  return { shown: lines.slice(start), hidden: start };
}

function OutputLineView({ line }: { line: OutputLine }) {
  if (line.kind === 'heading') {
    return (
      <Text bold color="cyan">
        {line.text}
      </Text>
    );
  }
  if (line.kind === 'raw') return <Text>{line.text}</Text>;
  return (
    <Text>
      <Text color={COLOR[line.kind]}>{PREFIX[line.kind]}</Text>
      <Text color={line.kind === 'error' ? 'red' : undefined}>{line.text}</Text>
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
      borderColor="gray"
      flexDirection="column"
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
    >
      <Text bold color="cyan" wrap="truncate">
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
  const items = prompt.options.map((o, i) => ({ key: String(i), label: o.label, value: i }));
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">
        {prompt.message}
      </Text>
      <SelectInput
        items={items}
        limit={limit}
        onSelect={(item) => prompt.resolve(prompt.options[item.value].value)}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? 'cyan' : undefined} wrap="truncate">
            {label}
          </Text>
        )}
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
        <Text color="cyan">› </Text>
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
        <Text inverse={yes} color={yes ? 'cyan' : undefined}>
          {' Yes '}
        </Text>
        <Text> </Text>
        <Text inverse={!yes} color={!yes ? 'cyan' : undefined}>
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
      borderColor={prompt?.kind === 'confirm' && prompt.danger ? 'red' : 'cyan'}
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
    <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
      <Text wrap="truncate">
        <Text bold color="cyan">
          {config.primaryDomain}
        </Text>
        <Text dimColor> · container </Text>
        <ContainerBadge status={dashboard.containerStatus} />
        <Text dimColor> · cloudflare </Text>
        {dashboard.cloudflareConfigured ? <Text color="green">●</Text> : <Text dimColor>○</Text>}
      </Text>
      {refreshing ? (
        <Text color="yellow">
          <Spinner type="dots" />
        </Text>
      ) : null}
    </Box>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

const SIDE_BY_SIDE_MIN_COLUMNS = 90;
const COMPACT_HEADER_MAX_ROWS = 32;

export function App() {
  const state = useSyncExternalStore(ui.subscribe, ui.getState);
  const { columns, rows } = useTerminalSize();
  const { prompt, busy, dashboard, refreshing } = state;

  const compact = rows < COMPACT_HEADER_MAX_ROWS;
  const headerRows = compact ? 3 : 6;
  const tableRows = 3 + Math.max(1, dashboard.domains.length);
  // Header, table, footer (1) and one spare row so the frame never fills the terminal.
  const body = Math.max(8, rows - headerRows - tableRows - 1 - 1);

  const sideBySide = columns >= SIDE_BY_SIDE_MIN_COLUMNS;
  const promptWidth = sideBySide ? Math.min(46, Math.max(34, Math.floor(columns * 0.35))) : columns;
  const promptHeight = sideBySide ? body : Math.min(body - 4, promptRowsFor(prompt, busy) + 2);
  const outputWidth = sideBySide ? columns - promptWidth - 1 : columns;
  const outputHeight = sideBySide ? body : body - promptHeight;

  const hint = busy ? 'working…' : prompt ? HINTS[prompt.kind] : '';

  return (
    <Box flexDirection="column" width={columns}>
      {compact ? (
        <CompactHeader dashboard={dashboard} refreshing={refreshing} />
      ) : (
        <Header dashboard={dashboard} refreshing={refreshing} />
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
        {columns >= 80 && <Text dimColor>● ok ○ miss ▲ diff ? unknown </Text>}
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
