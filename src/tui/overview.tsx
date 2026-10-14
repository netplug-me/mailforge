import React from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { formatKb, LogClass } from '../services/ops.js';
import { C, fit, truncate } from './theme.js';
import { Panel } from './widgets.js';
import { Line, ScreenProps, Seg } from './screens.js';
import { LOG_FILTERS, LogRow, banRows, f2bFeed, formatSpan, logRows, mailRows, pulseTiles, sparkline, today } from './overview-model.js';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const CLASS_STYLE: Record<LogClass, { word: string; color?: string; dim?: boolean }> = {
  out: { word: 'sent', color: C.ok },
  in: { word: 'recv', color: C.accent },
  bounce: { word: 'bounce', color: C.bad },
  defer: { word: 'defer', color: C.warn },
  blocked: { word: 'BLOCKED', color: C.bad },
  reject: { word: 'reject', color: C.warn },
  login: { word: 'login', color: C.violet },
  authfail: { word: 'AUTHFAIL', color: C.bad },
  probe: { word: 'probe', color: C.pink },
  system: { word: 'system', color: C.accent2 },
  session: { word: 'sess', dim: true },
  other: { word: '', dim: true },
  noise: { word: 'noise', dim: true },
};

/** A tile cell of exactly `width` columns: big value, dim sub-text. */
function cell(value: string, sub: string | undefined, color: string, width: number): Seg[] {
  const v = truncate(value, Math.max(1, width - 1));
  const rest = width - stringWidth(v);
  const s = sub ? truncate(` · ${sub}`, rest) : '';
  return [
    { t: v, color, bold: true },
    { t: s, dim: true },
    { t: ' '.repeat(Math.max(0, rest - stringWidth(s))) },
  ];
}

function Pulse({ dashboard, width, height }: Pick<ScreenProps, 'dashboard' | 'width' | 'height'>) {
  const live = dashboard.live;
  const inner = width - 4;
  const tiles = pulseTiles(live, dashboard.health?.certDays);
  const count = clamp(Math.floor(inner / 15), 3, tiles.length);
  const shown = tiles.slice(0, count);
  const cw = Math.floor(inner / count);
  const span = live?.stats.spanMs ? `last ${formatSpan(live.stats.spanMs)}` : 'waiting for the mail server';
  const updated = live?.at ? live.at.toLocaleTimeString([], { hour12: false }) : '';

  const values: Seg[] = shown.flatMap((t) => cell(t.value, t.sub, t.color, cw));
  const labels: Seg[] = shown.map((t) => ({ t: fit(t.label, cw), dim: true }));
  const sparkRow = height >= 6 && live;
  const half = Math.floor((inner - 2) / 2);

  return (
    <Panel title={`Pulse · ${span}`} right={live?.error ? `poll failed: ${truncate(live.error, 40)}` : updated} color={live?.error ? C.warn : C.accent} width={width} height={height}>
      <Line segs={values} width={inner} />
      <Line segs={labels} width={inner} />
      {sparkRow && (
        <Line
          width={inner}
          segs={[
            { t: 'mail ', dim: true },
            { t: sparkline(live.stats.mail, Math.max(4, half - 5)), color: C.accent },
            { t: '  ' },
            { t: 'threats ', dim: true },
            { t: sparkline(live.stats.threats, Math.max(4, inner - half - 2 - 8)), color: C.pink },
          ]}
        />
      )}
    </Panel>
  );
}

function RecentMail({ dashboard, width, height }: Pick<ScreenProps, 'dashboard' | 'width' | 'height'>) {
  const live = dashboard.live;
  const inner = width - 4;
  const rows = Math.max(1, height - 3);
  const data = mailRows(live, rows);
  const timeW = Math.max(8, ...data.map((r) => r.when.length)) + 1;
  const stW = 7;
  const rest = Math.max(10, inner - timeW - stW - 2);
  const viaW = clamp(Math.max(0, ...data.map((r) => r.via.length)) + 2, 12, Math.floor(rest * 0.5));
  const whoW = rest - viaW;
  const idle = live && live.stats.counts.out === 0 && data.length < rows;
  return (
    <Panel title="Recent mail" right={live ? `${live.stats.counts.in} in · ${live.stats.counts.out} out` : undefined} color={C.ok} width={width} height={height}>
      {data.length === 0 ? (
        <Text dimColor wrap="truncate">{live ? 'No mail moved in this window.' : 'Waiting for the mail server…'}</Text>
      ) : (
        data.map((r, i) => {
          const st = CLASS_STYLE[r.cls];
          return (
            <Line
              key={i}
              width={inner}
              segs={[
                { t: fit(r.when, timeW), dim: true },
                { t: r.dir === 'out' ? '→ ' : '← ', color: st.color },
                { t: fit(st.word, stW - 2), color: st.color, bold: true },
                { t: ' ' },
                { t: fit(r.who, whoW) },
                { t: ' ' },
                { t: fit(r.via, viaW - 1), dim: true },
              ]}
            />
          );
        })
      )}
      {idle && data.length > 0 && <Text dimColor wrap="truncate">· nothing sent in the last {formatSpan(live.stats.spanMs)}</Text>}
    </Panel>
  );
}

function Bans({ dashboard, width, height }: Pick<ScreenProps, 'dashboard' | 'width' | 'height'>) {
  const live = dashboard.live;
  const inner = width - 4;
  const rows = Math.max(1, height - 3);
  const bans = banRows(live);
  const watcher = live?.watcher;
  const sync = watcher === 'active' ? { t: '● proxy sync', color: C.ok } : { t: `○ proxy sync ${watcher ?? 'n/a'}`, color: C.warn };
  // Show every ban when there is room to spare for the divider and an event; otherwise keep some feed.
  const banCap = bans.length <= rows - 2 ? bans.length : Math.max(1, rows - 3);
  const feed = f2bFeed(live?.f2bEvents, Math.max(0, rows - Math.min(bans.length, banCap) - (bans.length === 0 ? 1 : 0) - 1));
  const lines: Seg[][] = [];
  if (!live?.jails) lines.push([{ t: 'fail2ban is not answering', color: C.warn }]);
  else if (bans.length === 0) lines.push([{ t: '● nobody is banned', color: C.ok }]);
  for (const b of bans.slice(0, banCap)) {
    lines.push([{ t: '⊘ ', color: C.bad }, { t: fit(b.ip, 16), bold: true }, { t: b.jails.join(' '), dim: true }]);
  }
  if (bans.length > banCap) lines.push([{ t: `  +${bans.length - banCap} more`, dim: true }]);
  if (feed.length) lines.push([{ t: '─ recent ' + '─'.repeat(Math.max(0, inner - 9)), color: C.border }]);
  for (const e of feed) {
    const color = e.action === 'ban' ? C.bad : e.action === 'unban' ? C.ok : C.warn;
    lines.push([
      { t: fit(e.when.slice(0, 11), 12), dim: true },
      { t: fit(e.action === 'found' ? 'strike' : e.action, 7), color },
      { t: fit(e.ip, 16) },
      { t: `${e.jail}${e.count > 1 ? ` ×${e.count}` : ''}`, dim: true },
    ]);
  }
  return (
    <Panel title={`Bans · ${bans.length}`} right={sync.t} color={bans.length ? C.bad : C.pink} width={width} height={height}>
      {lines.slice(0, rows).map((segs, i) => (
        <Line key={i} segs={segs} width={inner} />
      ))}
    </Panel>
  );
}

function System({ dashboard, width, height }: Pick<ScreenProps, 'dashboard' | 'width' | 'height'>) {
  const live = dashboard.live;
  const inner = width - 4;
  const rows = Math.max(1, height - 3);
  const up = live?.startedAt ? formatSpan(Date.now() - live.startedAt.getTime()) : '—';
  const c = live?.container;
  const users = new Map<string, number>();
  for (const cl of live?.clients ?? []) users.set(cl.user, (users.get(cl.user) ?? 0) + cl.connections);
  const lines: Seg[][] = [
    [{ t: fit('uptime', 8), dim: true }, { t: up }, { t: `  ·  load ${live?.load ?? '—'}`, dim: true }],
    [{ t: fit('mailsrv', 8), dim: true }, { t: c ? `${c.mem} (${c.memPct.toFixed(1)}%)  ·  cpu ${c.cpu}` : '—' }],
    [
      { t: fit('queue', 8), dim: true },
      live?.queue
        ? { t: `${live.queue.total}`, color: live.queue.deferred ? C.warn : C.ok, bold: true }
        : { t: '—' },
      { t: live?.queue ? `  ·  ${live.queue.deferred} deferred  ·  ${live.queue.active} active` : '', dim: true },
    ],
  ];
  for (const [user, n] of users) lines.push([{ t: fit('online', 8), dim: true }, { t: '◉ ', color: C.ok }, { t: user }, { t: n > 1 ? ` ×${n}` : '', dim: true }]);
  if (users.size === 0) lines.push([{ t: fit('online', 8), dim: true }, { t: 'no IMAP sessions', dim: true }]);
  const usage = dashboard.usage ? Object.values(dashboard.usage) : [];
  if (usage.length) {
    const total = usage.reduce((n, u) => n + u.usedKb, 0);
    lines.push([{ t: fit('storage', 8), dim: true }, { t: `${formatKb(total)} across ${usage.length} mailbox${usage.length === 1 ? '' : 'es'}` }]);
  }
  return (
    <Panel title="System" color={C.accent2} width={width} height={height}>
      {lines.slice(0, rows).map((segs, i) => (
        <Line key={i} segs={segs} width={inner} />
      ))}
    </Panel>
  );
}

function LiveLog({ dashboard, width, height, nav }: Pick<ScreenProps, 'dashboard' | 'width' | 'height' | 'nav'>) {
  const live = dashboard.live;
  const inner = width - 4;
  const rows = Math.max(1, height - 3);
  const all = logRows(live, nav.ovFilter);
  const scroll = clamp(nav.ovScroll, 0, Math.max(0, all.length - rows));
  const end = all.length - scroll;
  const shown = all.slice(Math.max(0, end - rows), end);
  const filter = LOG_FILTERS[nav.ovFilter % LOG_FILTERS.length].label;
  const procW = 9;
  const stW = 9;
  const todayKey = today();
  const timeW = shown.some((r) => r.day && r.day !== todayKey) ? 13 : 9;
  const textW = Math.max(8, inner - timeW - stW - procW);
  const right = scroll > 0 ? `${scroll} newer below · pgdn` : `following · ${all.length} events`;
  return (
    <Panel title={`Live log · ${filter}`} right={right} color={C.violet} width={width} height={height}>
      {shown.length === 0 ? (
        <Text dimColor wrap="truncate">{live ? 'Nothing to show for this filter.' : 'Waiting for the mail server…'}</Text>
      ) : (
        shown.map((r: LogRow, i) => {
          const st = CLASS_STYLE[r.cls];
          const text = r.count > 1 ? `${truncate(r.text, textW - 5)} ×${r.count}` : r.text;
          return (
            <Line
              key={`${end}-${i}`}
              width={inner}
              segs={[
                { t: fit(r.day && r.day !== todayKey ? `${r.day} ${r.time}` : r.time, timeW), dim: true },
                { t: fit(st.word, stW), color: st.color, bold: !st.dim, dim: st.dim },
                { t: fit(r.proc, procW), dim: true },
                { t: fit(text, textW), dim: st.dim && r.cls !== 'other' },
              ]}
            />
          );
        })
      )}
    </Panel>
  );
}

export function OverviewScreen({ dashboard, width, height, active, nav, patchNav }: ScreenProps) {
  const logLen = logRows(dashboard.live, nav.ovFilter).length;

  useInput(
    (input, key) => {
      const page = Math.max(1, Math.floor(height / 3));
      if (input === 'f') patchNav({ ovFilter: (nav.ovFilter + 1) % LOG_FILTERS.length, ovScroll: 0 });
      else if (key.upArrow || input === 'k') patchNav({ ovScroll: Math.min(Math.max(0, logLen - 1), nav.ovScroll + 1) });
      else if (key.downArrow || input === 'j') patchNav({ ovScroll: Math.max(0, nav.ovScroll - 1) });
      else if (key.pageUp) patchNav({ ovScroll: Math.min(Math.max(0, logLen - 1), nav.ovScroll + page) });
      else if (key.pageDown) patchNav({ ovScroll: Math.max(0, nav.ovScroll - page) });
      else if (input === 'G' || key.end) patchNav({ ovScroll: 0 });
    },
    { isActive: active }
  );

  const pulseH = height >= 26 ? 6 : 5;
  const rest = height - pulseH;
  const midH = rest < 10 ? 0 : clamp(Math.round(rest * 0.52), 6, 20);
  const logH = rest - midH;
  const sideBySide = width >= 84;
  const mailW = sideBySide ? Math.floor(width * 0.56) : width;
  const sideW = width - mailW - 1;
  // The right column holds Bans, plus System when there is room for both.
  const both = midH >= 14;
  const systemH = both ? 8 : 0;
  const bansH = midH - systemH;

  return (
    <Box width={width} height={height} flexDirection="column">
      <Pulse dashboard={dashboard} width={width} height={pulseH} />
      {midH > 0 && (
        <Box width={width} height={midH} gap={1}>
          <RecentMail dashboard={dashboard} width={mailW} height={midH} />
          {sideBySide && (
            <Box flexDirection="column" width={sideW} height={midH}>
              <Bans dashboard={dashboard} width={sideW} height={bansH} />
              {both && <System dashboard={dashboard} width={sideW} height={systemH} />}
            </Box>
          )}
        </Box>
      )}
      <LiveLog dashboard={dashboard} width={width} height={logH} nav={nav} />
    </Box>
  );
}
