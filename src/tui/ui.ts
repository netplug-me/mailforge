import { CloudflareZone, DomainInfo } from '../types.js';

// Bridge between the imperative action flows (actions.ts) and the Ink view (App.tsx).
// Actions `await ui.select(...)` etc.; the view renders whatever prompt is pending and
// resolves it when the user answers. Only one prompt is ever pending, so only one
// component listens for keys at a time.

export const CANCEL = Symbol('cancel');
export type Cancel = typeof CANCEL;
export const isCancel = (v: unknown): v is Cancel => v === CANCEL;

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Glyph shown before the label, in `color`. */
  icon?: string;
  color?: string;
  /** Dim text after the label. */
  hint?: string;
}

export type Prompt =
  | {
      kind: 'select';
      message: string;
      options: SelectOption<unknown>[];
      resolve: (v: unknown) => void;
    }
  | {
      kind: 'text';
      message: string;
      placeholder?: string;
      mask?: boolean;
      validate?: (v: string) => string | undefined;
      resolve: (v: string | Cancel) => void;
    }
  | {
      kind: 'confirm';
      message: string;
      initial: boolean;
      danger?: boolean;
      resolve: (v: boolean | Cancel) => void;
    };

export type OutputKind = 'info' | 'success' | 'warn' | 'error' | 'text' | 'heading' | 'raw';

export interface OutputLine {
  kind: OutputKind;
  text: string;
  /** Overrides the colour the kind would get. */
  color?: string;
}

/** State of the mail path, shown in the header. Each stage is a compose service state or undefined when absent. */
export interface Health {
  bridge?: string;
  tunnel?: string;
  relay: boolean;
  /** Days until the TLS certificate expires. */
  certDays?: number;
}

export interface DashboardData {
  domains: DomainInfo[];
  containerStatus: 'running' | 'exited' | 'stopped' | 'not_found';
  cloudflareConfigured: boolean;
  health?: Health;
  /** Zones on the Cloudflare account; undefined until first loaded. */
  zones?: CloudflareZone[];
  zonesError?: string;
  refreshedAt?: Date;
}

export interface UiState {
  prompt?: Prompt;
  /** Changes with every new prompt, so the view can reset per-prompt input state. */
  promptId: number;
  busy?: string;
  outputTitle?: string;
  output: OutputLine[];
  dashboard: DashboardData;
  refreshing: boolean;
}

class UiController {
  private state: UiState = {
    promptId: 0,
    output: [],
    dashboard: { domains: [], containerStatus: 'not_found', cloudflareConfigured: false },
    refreshing: true,
  };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.state;

  private setPrompt(prompt: Prompt) {
    this.set({ prompt, promptId: this.state.promptId + 1 });
  }

  private set(patch: Partial<UiState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ── prompts ────────────────────────────────────────────────────────────────

  select<T>(message: string, options: SelectOption<T>[]): Promise<T | Cancel> {
    return new Promise((resolve) => {
      this.setPrompt({
        kind: 'select',
        message,
        options: options as SelectOption<unknown>[],
        resolve: (v) => {
          this.set({ prompt: undefined });
          resolve(v as T | Cancel);
        },
      });
    });
  }

  text(
    message: string,
    opts: { placeholder?: string; mask?: boolean; validate?: (v: string) => string | undefined } = {}
  ): Promise<string | Cancel> {
    return new Promise((resolve) => {
      this.setPrompt({
        kind: 'text',
        message,
        ...opts,
        resolve: (v) => {
          this.set({ prompt: undefined });
          resolve(v);
        },
      });
    });
  }

  confirm(message: string, opts: { initial?: boolean; danger?: boolean } = {}): Promise<boolean | Cancel> {
    return new Promise((resolve) => {
      this.setPrompt({
        kind: 'confirm',
        message,
        initial: opts.initial ?? false,
        danger: opts.danger,
        resolve: (v) => {
          this.set({ prompt: undefined });
          resolve(v);
        },
      });
    });
  }

  // ── progress ───────────────────────────────────────────────────────────────

  /**
   * Shows a spinner while `fn` runs. Yields one tick first so the message is painted
   * even when `fn` makes blocking (spawnSync) calls.
   */
  async task<T>(message: string, fn: () => T | Promise<T>): Promise<T> {
    this.set({ busy: message });
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await fn();
    } finally {
      this.set({ busy: undefined });
    }
  }

  // ── output panel ───────────────────────────────────────────────────────────

  /** Starts a fresh output panel for a new action. Results persist until the next one. */
  begin(title: string) {
    this.set({ outputTitle: title, output: [] });
  }

  private push(kind: OutputKind, text: string, color?: string) {
    const lines = text.split(/\r?\n/).map((t) => ({ kind, text: t, color }));
    this.set({ output: [...this.state.output, ...lines] });
  }

  info = (t: string) => this.push('info', t);
  success = (t: string) => this.push('success', t);
  warn = (t: string) => this.push('warn', t);
  error = (t: string) => this.push('error', t);
  line = (t: string) => this.push('text', t);
  /** An indented line in an explicit colour (colour names or #hex). */
  colored = (t: string, color: string) => this.push('text', t, color);
  heading = (t: string) => this.push('heading', t);
  /** Unstyled, unindented: for values the user needs to copy (DKIM TXT, logs). */
  raw = (t: string) => this.push('raw', t);

  // ── dashboard ──────────────────────────────────────────────────────────────

  setRefreshing(refreshing: boolean) {
    this.set({ refreshing });
  }

  setDashboard(dashboard: DashboardData) {
    this.set({ dashboard, refreshing: false });
  }
}

export const ui = new UiController();
