import React, { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { Box, useInput } from 'ink';
import { DmsService } from '../services/dms.js';
import { DomainManager } from '../services/domain-manager.js';
import { ui } from './ui.js';
import {
  ConfirmDialog,
  FormDialog,
  Footer,
  Hint,
  NoticeDialog,
  SelectDock,
  StatusBar,
  Tabs,
  TabSpec,
  TextDock,
  dockRowsFor,
  useTerminalSize,
} from './widgets.js';
import { DomainsScreen, MailboxesScreen, Nav, ScreenKey, ToolsScreen } from './screens.js';
import { refreshDashboard } from './dashboard.js';

const SCREEN_ORDER: ScreenKey[] = ['mailboxes', 'domains', 'tools'];

const INITIAL_NAV: Nav = { screen: 'mailboxes', mbxSel: 0, mbxFilter: 0, domSel: 0, toolSel: 0, outScroll: 0 };

const HINTS: Record<ScreenKey, Hint[]> = {
  mailboxes: [
    { key: 'a', label: 'add mailbox' },
    { key: 'l', label: 'alias' },
    { key: 'p', label: 'password' },
    { key: 'q', label: 'quota' },
    { key: 'd', label: 'delete' },
    { key: 'f', label: 'filter' },
    { key: '↵', label: 'actions' },
  ],
  domains: [
    { key: 'a', label: 'add' },
    { key: 'x', label: 'remove' },
    { key: 's', label: 'sync DNS' },
    { key: 'k', label: 'DKIM' },
    { key: '↵', label: 'actions' },
  ],
  tools: [
    { key: '↵', label: 'run' },
    { key: 'pgup/pgdn', label: 'scroll output' },
  ],
};

const GLOBAL_HINTS: Hint[] = [
  { key: 'tab', label: 'next screen' },
  { key: 'r', label: 'refresh' },
  { key: 'ctrl+c', label: 'quit' },
];

const DIALOG_HINT: Hint[] = [];

export function App({ dm }: { dm: DomainManager }) {
  const state = useSyncExternalStore(ui.subscribe, ui.getState);
  const { columns, rows } = useTerminalSize();
  const { prompt, busy, dashboard, refreshing } = state;
  const [nav, setNav] = useState<Nav>(INITIAL_NAV);
  const patchNav = useCallback((patch: Partial<Nav>) => setNav((n) => ({ ...n, ...patch })), []);
  const ctx = useRef({ dm, dms: new DmsService() }).current;

  // A flow holds the keyboard from its first prompt to its last refresh.
  const running = useRef(false);
  const [, force] = useState(0);
  const run = useCallback((fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    force((n) => n + 1);
    fn()
      .catch((err) => ui.toast('error', err?.message ?? String(err), 10000))
      .finally(() => {
        running.current = false;
        force((n) => n + 1);
      });
  }, []);

  const idle = !prompt && !busy && !running.current;

  useInput(
    (input, key) => {
      const index = SCREEN_ORDER.indexOf(nav.screen);
      if (key.tab) {
        const step = key.shift ? -1 : 1;
        patchNav({ screen: SCREEN_ORDER[(index + step + SCREEN_ORDER.length) % SCREEN_ORDER.length] });
      } else if (input >= '1' && input <= String(SCREEN_ORDER.length)) patchNav({ screen: SCREEN_ORDER[Number(input) - 1] });
      else if (input === 'r') {
        ui.toast('info', 'Refreshing…', 2000);
        void refreshDashboard(dm);
      }
    },
    { isActive: idle }
  );

  const tabs: TabSpec[] = [
    { key: 'mailboxes', label: 'Mailboxes', count: dashboard.accounts.length },
    { key: 'domains', label: 'Domains', count: dashboard.domains.length },
    { key: 'tools', label: 'Tools' },
  ];

  // Status bar, tabs, toast line and hint line, plus one spare row so the frame never
  // fills the terminal (Ink then falls back to clear-and-redraw on every update).
  const chrome = 2 + 2 + 1;
  const body = Math.max(8, rows - chrome);

  const dialog = prompt && (prompt.kind === 'form' || prompt.kind === 'confirm' || prompt.kind === 'notice');
  const dockWanted = dockRowsFor(prompt);
  const dock = dockWanted > 0 ? Math.min(dockWanted, Math.max(5, Math.floor(body * 0.55))) : 0;
  const screenHeight = body - dock;

  const screenProps = {
    dashboard,
    ctx,
    width: columns,
    height: screenHeight,
    active: idle,
    nav,
    patchNav,
    run,
  };

  let content: React.ReactNode;
  if (dialog && prompt) {
    content =
      prompt.kind === 'form' ? (
        <FormDialog key={state.promptId} prompt={prompt} columns={columns} height={body} />
      ) : prompt.kind === 'confirm' ? (
        <ConfirmDialog key={state.promptId} prompt={prompt} columns={columns} height={body} />
      ) : (
        <NoticeDialog key={state.promptId} prompt={prompt} columns={columns} height={body} />
      );
  } else {
    content = (
      <>
        {nav.screen === 'mailboxes' && <MailboxesScreen {...screenProps} />}
        {nav.screen === 'domains' && <DomainsScreen {...screenProps} />}
        {nav.screen === 'tools' && <ToolsScreen {...screenProps} state={state} />}
        {prompt?.kind === 'select' && <SelectDock prompt={prompt} promptId={state.promptId} width={columns} height={dock} />}
        {prompt?.kind === 'text' && <TextDock key={state.promptId} prompt={prompt} width={columns} height={dock} />}
      </>
    );
  }

  const hints = dialog ? DIALOG_HINT : prompt ? [{ key: '↑↓', label: 'move' }, { key: '↵', label: 'select' }, { key: 'esc', label: 'back' }] : [...HINTS[nav.screen], ...GLOBAL_HINTS];

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar dashboard={dashboard} refreshing={refreshing} columns={columns} />
      <Tabs tabs={tabs} active={nav.screen} columns={columns} />
      <Box flexDirection="column" height={body} flexShrink={0} overflow="hidden">
        {content}
      </Box>
      <Footer hints={hints} toast={state.toast} busy={busy} columns={columns} />
    </Box>
  );
}

