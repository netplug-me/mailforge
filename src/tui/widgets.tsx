import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import stringWidth from 'string-width';
import { getAppConfig } from '../config.js';
import { CANCEL, DashboardData, FormField, FormValues, Health, OutputLine, Prompt, Toast } from './ui.js';
import { C, gradientAt, truncate } from './theme.js';

// ── Basics ───────────────────────────────────────────────────────────────────

export function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return size;
}

/** One <Text> per character, blended across the palette's gradient stops. */
export function Gradient({ text }: { text: string }) {
  const chars = [...text];
  return (
    <Text bold>
      {chars.map((c, i) => (
        <Text key={i} color={gradientAt(C.gradient, chars.length > 1 ? i / (chars.length - 1) : 0)}>
          {c}
        </Text>
      ))}
    </Text>
  );
}

/** A bordered box with a title row. `height` includes the border. */
export function Panel({
  title,
  right,
  color = C.border,
  width,
  height,
  children,
}: {
  title?: string;
  right?: string;
  color?: string;
  width: number;
  height: number;
  children?: React.ReactNode;
}) {
  const inner = width - 4;
  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      width={width}
      height={height}
      flexShrink={0}
      overflow="hidden"
    >
      {title !== undefined && (
        <Box justifyContent="space-between" width={inner}>
          <Text bold color={color === C.border ? C.accent : color} wrap="truncate">
            {title}
          </Text>
          {right ? (
            <Text dimColor wrap="truncate">
              {right}
            </Text>
          ) : null}
        </Box>
      )}
      {children}
    </Box>
  );
}

// ── Status bar and tabs ──────────────────────────────────────────────────────

function Dot({ label, state }: { label: string; state?: string }) {
  const color = state === 'running' ? C.ok : state ? C.warn : C.bad;
  const glyph = state === 'running' ? '●' : state ? '▲' : '○';
  return (
    <Text>
      <Text color={color}>{glyph}</Text>
      <Text dimColor> {label}</Text>
    </Text>
  );
}

function certColor(days: number): string {
  return days < 14 ? C.bad : days < 30 ? C.warn : C.ok;
}

function containerState(status: DashboardData['containerStatus']): string | undefined {
  return status === 'running' ? 'running' : status === 'not_found' ? undefined : status;
}

export function StatusBar({
  dashboard,
  refreshing,
  columns,
}: {
  dashboard: DashboardData;
  refreshing: boolean;
  columns: number;
}) {
  const config = getAppConfig();
  const health: Health | undefined = dashboard.health;
  const time = dashboard.refreshedAt?.toLocaleTimeString([], { hour12: false });
  const wide = columns >= 100;
  return (
    <Box width={columns} justifyContent="space-between">
      <Text wrap="truncate">
        <Gradient text="✉ mailctl" />
        <Text dimColor> {config.primaryDomain}</Text>
        <Text>  </Text>
        <Dot label="mail" state={containerState(dashboard.containerStatus)} />
        {wide && (
          <>
            <Text> </Text>
            <Dot label="bridge" state={health?.bridge} />
            <Text> </Text>
            <Dot label="tunnel" state={health?.tunnel} />
            <Text> </Text>
            <Dot label="relay" state={health?.relay ? 'running' : undefined} />
            <Text> </Text>
            <Dot label="cf" state={dashboard.cloudflareConfigured ? 'running' : undefined} />
          </>
        )}
        {health?.certDays !== undefined && (
          <Text color={certColor(health.certDays)}>  ⚿ tls {health.certDays}d</Text>
        )}
      </Text>
      <Text wrap="truncate">
        {refreshing ? (
          <Text color={C.warn}>
            <Spinner type="dots" /> refreshing{' '}
          </Text>
        ) : (
          <Text dimColor>{time ? `updated ${time} ` : ''}</Text>
        )}
      </Text>
    </Box>
  );
}

export interface TabSpec {
  key: string;
  label: string;
  count?: number;
}

export function Tabs({ tabs, active, columns }: { tabs: TabSpec[]; active: string; columns: number }) {
  return (
    <Box width={columns}>
      <Text wrap="truncate">
        {tabs.map((t, i) => {
          const on = t.key === active;
          return (
            <Text key={t.key}>
              <Text backgroundColor={on ? C.accent : undefined} color={on ? '#0f172a' : C.muted} bold={on}>
                {` ${i + 1} ${t.label}${t.count !== undefined ? ` ${t.count}` : ''} `}
              </Text>
              <Text> </Text>
            </Text>
          );
        })}
      </Text>
    </Box>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

export interface Hint {
  key: string;
  label: string;
}

const TOAST_COLOR: Record<Toast['kind'], string> = { success: C.ok, error: C.bad, warn: C.warn, info: C.accent };
const TOAST_GLYPH: Record<Toast['kind'], string> = { success: '✔', error: '✖', warn: '!', info: '›' };

export function Footer({
  hints,
  toast,
  busy,
  columns,
}: {
  hints: Hint[];
  toast?: Toast;
  busy?: string;
  columns: number;
}) {
  return (
    <Box flexDirection="column" width={columns}>
      <Box height={1}>
        {busy ? (
          <Text color={C.warn} wrap="truncate">
            <Spinner type="dots" /> {busy}
          </Text>
        ) : toast ? (
          <Text color={TOAST_COLOR[toast.kind]} wrap="truncate">
            {TOAST_GLYPH[toast.kind]} {toast.text}
          </Text>
        ) : null}
      </Box>
      <Text wrap="truncate">
        {hints.map((h, i) => (
          <Text key={h.key + i}>
            <Text color={C.accent} bold>
              {h.key}
            </Text>
            <Text dimColor> {h.label}</Text>
            <Text>  </Text>
          </Text>
        ))}
      </Text>
    </Box>
  );
}

// ── Output lines (used by the Tools screen and notices) ──────────────────────

const PREFIX: Record<OutputLine['kind'], string> = {
  success: '✔ ',
  error: '✖ ',
  warn: '! ',
  info: '› ',
  text: '  ',
  heading: '',
  raw: '',
};

const KIND_COLOR: Partial<Record<OutputLine['kind'], string>> = {
  success: C.ok,
  error: C.bad,
  warn: C.warn,
  info: C.accent,
};

export function rowsFor(line: OutputLine, width: number): number {
  return Math.max(1, Math.ceil(stringWidth(PREFIX[line.kind] + line.text) / Math.max(1, width)));
}

/**
 * The lines that fit in `rows` terminal rows when scrolled `offset` lines up from the
 * newest, plus how many lie above and below the window.
 */
export function windowLines(lines: OutputLine[], rows: number, width: number, offset: number) {
  const end = Math.max(0, lines.length - offset);
  let used = 0;
  let start = end;
  while (start > 0 && used + rowsFor(lines[start - 1], width) <= rows) {
    used += rowsFor(lines[--start], width);
  }
  return { shown: lines.slice(start, end), above: start, below: lines.length - end };
}

export function OutputLineView({ line }: { line: OutputLine }) {
  if (line.kind === 'heading') {
    return (
      <Text bold color={C.violet}>
        {line.text}
      </Text>
    );
  }
  if (line.kind === 'raw') return <Text color={line.color}>{line.text}</Text>;
  return (
    <Text>
      <Text color={KIND_COLOR[line.kind]}>{PREFIX[line.kind]}</Text>
      <Text color={line.color ?? (line.kind === 'error' ? C.bad : undefined)}>{line.text}</Text>
    </Text>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

/** Centres a dialog in the body area. */
export function DialogFrame({
  title,
  color = C.accent,
  width,
  height,
  columns,
  footer,
  children,
}: {
  title: string;
  color?: string;
  width: number;
  height: number;
  columns: number;
  footer: string;
  children: React.ReactNode;
}) {
  return (
    <Box width={columns} height={height} justifyContent="center" alignItems="center" flexShrink={0}>
      <Box
        borderStyle="round"
        borderColor={color}
        flexDirection="column"
        paddingX={2}
        paddingY={0}
        width={width}
        overflow="hidden"
      >
        <Text bold color={color} wrap="truncate">
          {title}
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {children}
        </Box>
        <Box marginTop={1}>
          <Text dimColor wrap="truncate">
            {footer}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

const LABEL_WIDTH = 18;

function initialValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    if (f.kind === 'text') values[f.key] = f.initial ?? '';
    else if (f.kind === 'select') values[f.key] = f.initial ?? f.options[0]?.value ?? '';
    else values[f.key] = f.initial ?? false;
  }
  return values;
}

export function FormDialog({
  prompt,
  columns,
  height,
}: {
  prompt: Extract<Prompt, { kind: 'form' }>;
  columns: number;
  height: number;
}) {
  const { fields } = prompt;
  const [values, setValues] = useState<FormValues>(() => initialValues(fields));
  const [focus, setFocus] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const width = Math.min(76, columns - 2);
  const current = fields[focus];
  const last = focus === fields.length - 1;

  const set = (key: string, value: string | boolean) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: '' } : e));
  };

  const validateField = (f: FormField, all: FormValues): string | undefined =>
    f.kind === 'text' ? f.validate?.(String(all[f.key] ?? ''), all) : undefined;

  const submit = () => {
    const next: Record<string, string> = {};
    for (const f of fields) {
      const err = validateField(f, values);
      if (err) next[f.key] = err;
    }
    const firstBad = fields.findIndex((f) => next[f.key]);
    if (firstBad >= 0) {
      setErrors(next);
      setFocus(firstBad);
      return;
    }
    prompt.resolve(values);
  };

  const advance = () => {
    const err = validateField(current, values);
    if (err) {
      setErrors((e) => ({ ...e, [current.key]: err }));
      return;
    }
    if (last) submit();
    else setFocus(focus + 1);
  };

  useInput((input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
    else if (key.tab && key.shift) setFocus((f) => Math.max(0, f - 1));
    else if (key.tab || key.downArrow) setFocus((f) => Math.min(fields.length - 1, f + 1));
    else if (key.upArrow) setFocus((f) => Math.max(0, f - 1));
    else if (current.kind === 'select') {
      const idx = current.options.findIndex((o) => o.value === values[current.key]);
      if (key.leftArrow) set(current.key, current.options[(idx - 1 + current.options.length) % current.options.length].value);
      else if (key.rightArrow || input === ' ') set(current.key, current.options[(idx + 1) % current.options.length].value);
      else if (key.return) advance();
    } else if (current.kind === 'toggle') {
      if (key.leftArrow || key.rightArrow || input === ' ') set(current.key, !values[current.key]);
      else if (key.return) advance();
    }
  });

  const hint = current.hint;
  return (
    <DialogFrame
      title={prompt.title}
      color={prompt.danger ? C.bad : C.accent}
      width={width}
      height={height}
      columns={columns}
      footer={`tab/↓ next · shift-tab/↑ back · enter ${last ? (prompt.submitLabel ?? 'submit').toLowerCase() : 'next'} · esc cancel`}
    >
      {fields.map((f, i) => {
        const focused = i === focus;
        return (
          <Box key={f.key} flexDirection="column">
            <Box>
              <Box width={LABEL_WIDTH} flexShrink={0}>
                <Text bold={focused} color={focused ? C.accent : undefined} wrap="truncate">
                  {focused ? '› ' : '  '}
                  {f.label}
                </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                {f.kind === 'text' ? (
                  <TextInput
                    value={String(values[f.key] ?? '')}
                    placeholder={f.placeholder}
                    mask={f.mask ? '•' : undefined}
                    focus={focused}
                    onChange={(v) => set(f.key, v)}
                    onSubmit={() => advance()}
                  />
                ) : f.kind === 'select' ? (
                  <Text>
                    <Text color={focused ? C.accent : C.faint}>◀ </Text>
                    <Text bold={focused}>{f.options.find((o) => o.value === values[f.key])?.label ?? '—'}</Text>
                    <Text color={focused ? C.accent : C.faint}> ▶</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text color={values[f.key] ? C.ok : C.faint}>{values[f.key] ? '[x]' : '[ ]'}</Text>
                    <Text dimColor={!focused}> {values[f.key] ? 'yes' : 'no'}</Text>
                  </Text>
                )}
              </Box>
            </Box>
            {errors[f.key] ? (
              <Text color={C.bad}>
                {' '.repeat(LABEL_WIDTH)}✖ {errors[f.key]}
              </Text>
            ) : focused && hint ? (
              <Text dimColor>
                {' '.repeat(LABEL_WIDTH)}
                {hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </DialogFrame>
  );
}

export function ConfirmDialog({
  prompt,
  columns,
  height,
}: {
  prompt: Extract<Prompt, { kind: 'confirm' }>;
  columns: number;
  height: number;
}) {
  const [yes, setYes] = useState(prompt.initial);
  useInput((input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
    else if (key.return) prompt.resolve(yes);
    else if (input.toLowerCase() === 'y') prompt.resolve(true);
    else if (input.toLowerCase() === 'n') prompt.resolve(false);
    else if (key.leftArrow || key.rightArrow || key.tab) setYes((v) => !v);
  });
  const color = prompt.danger ? C.bad : C.accent;
  return (
    <DialogFrame
      title={prompt.danger ? 'Are you sure?' : 'Confirm'}
      color={color}
      width={Math.min(70, columns - 2)}
      height={height}
      columns={columns}
      footer="y/n · ←→ toggle · enter confirm · esc cancel"
    >
      <Text>{prompt.message}</Text>
      <Box marginTop={1}>
        <Text inverse={yes} color={yes ? color : undefined} bold>
          {'  Yes  '}
        </Text>
        <Text> </Text>
        <Text inverse={!yes} color={!yes ? C.accent : undefined} bold>
          {'  No  '}
        </Text>
      </Box>
    </DialogFrame>
  );
}

export function NoticeDialog({
  prompt,
  columns,
  height,
}: {
  prompt: Extract<Prompt, { kind: 'notice' }>;
  columns: number;
  height: number;
}) {
  const [offset, setOffset] = useState(0);
  const width = Math.min(90, columns - 2);
  // Frame: border (2) + title (1) + two margins (2) + footer (1).
  const rows = Math.max(3, height - 6);
  const inner = width - 6;
  const { shown, above, below } = windowLines(prompt.lines, rows, inner, offset);
  const maxOffset = Math.max(0, prompt.lines.length - 1);
  useInput((_input, key) => {
    if (key.return || key.escape || _input === 'q') prompt.resolve();
    else if (key.upArrow) setOffset((o) => Math.min(maxOffset, o + 1));
    else if (key.downArrow) setOffset((o) => Math.max(0, o - 1));
    else if (key.pageUp) setOffset((o) => Math.min(maxOffset, o + rows));
    else if (key.pageDown) setOffset((o) => Math.max(0, o - rows));
  });
  const scrollable = above > 0 || below > 0;
  return (
    <DialogFrame
      title={prompt.title}
      width={width}
      height={height}
      columns={columns}
      footer={scrollable ? '↑↓ scroll · enter close' : 'enter close'}
    >
      {above > 0 && <Text dimColor>… {above} line(s) above</Text>}
      {shown.map((l, i) => (
        <OutputLineView key={above + i} line={l} />
      ))}
      {below > 0 && <Text dimColor>… {below} line(s) below</Text>}
    </DialogFrame>
  );
}

/** Vertical list docked under the screen; used for short pick-one questions. */
export function SelectDock({
  prompt,
  promptId,
  width,
  height,
}: {
  prompt: Extract<Prompt, { kind: 'select' }>;
  promptId: number;
  width: number;
  height: number;
}) {
  useInput((_input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
  });
  const items = prompt.options.map((o, i) => ({ key: String(i), label: String(i), value: i }));
  return (
    <Panel title={prompt.message} color={C.accent} width={width} height={height}>
      <SelectInput
        key={promptId}
        items={items}
        limit={Math.max(2, height - 3)}
        onSelect={(item) => prompt.resolve(prompt.options[item.value].value)}
        itemComponent={({ isSelected, label }) => {
          const o = prompt.options[Number(label)];
          return (
            <Text wrap="truncate">
              {o.icon && <Text color={o.color ?? C.accent}>{o.icon} </Text>}
              <Text bold={isSelected} color={isSelected ? C.accent : undefined}>
                {o.label}
              </Text>
              {o.hint && <Text dimColor> {o.hint}</Text>}
            </Text>
          );
        }}
        indicatorComponent={({ isSelected }) => <Text color={C.accent}>{isSelected ? '❯ ' : '  '}</Text>}
      />
    </Panel>
  );
}

/** Single-line text prompt, docked like the select list. */
export function TextDock({
  prompt,
  width,
  height,
}: {
  prompt: Extract<Prompt, { kind: 'text' }>;
  width: number;
  height: number;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  useInput((_input, key) => {
    if (key.escape) prompt.resolve(CANCEL);
  });
  return (
    <Panel title={prompt.message} color={C.accent} width={width} height={height}>
      <Box>
        <Text color={C.accent}>› </Text>
        <TextInput
          value={value}
          placeholder={prompt.placeholder}
          mask={prompt.mask ? '•' : undefined}
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
      {error && <Text color={C.bad}>✖ {truncate(error, width - 8)}</Text>}
    </Panel>
  );
}

/** Rows a docked prompt wants (content + border + title). */
export function dockRowsFor(prompt: Prompt | undefined): number {
  if (!prompt) return 0;
  if (prompt.kind === 'select') return prompt.options.length + 3;
  if (prompt.kind === 'text') return 5;
  return 0;
}
