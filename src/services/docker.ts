import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { getAppConfig } from '../config.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

export class DockerService {
  private projectDir: string;

  constructor(projectDir?: string) {
    this.projectDir = projectDir || getAppConfig().projectDir;
  }

  /**
   * `docker compose` plus -f flags for compose.yaml and whichever override files apply.
   * A plain `docker compose up` would recreate the mailserver without the inbound
   * (PERMIT_DOCKER) and outbound (Postmark relay) settings.
   */
  private composeArgs(): string[] {
    getAppConfig(this.projectDir); // loads .env into process.env
    const files = ['compose.yaml'];
    const overrides: Array<[string, string]> = [
      ['inbound/compose.inbound.yaml', 'BRIDGE_SECRET'],
      ['outbound/compose.outbound.yaml', 'POSTMARK_SERVER_TOKEN'],
    ];
    for (const [file, requiredVar] of overrides) {
      // These files fail interpolation without their variable, so skip them until it is set.
      if (fs.existsSync(path.join(this.projectDir, file)) && process.env[requiredVar]) files.push(file);
    }
    return ['compose', ...files.flatMap((f) => ['-f', f])];
  }

  public isDockerAvailable(): boolean {
    const res = spawnSync('docker', ['--version'], { encoding: 'utf-8' });
    return res.status === 0;
  }

  public getContainerStatus(containerName = 'mailserver'): 'running' | 'exited' | 'stopped' | 'not_found' {
    if (!this.isDockerAvailable()) return 'not_found';
    try {
      const res = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', containerName], {
        encoding: 'utf-8',
        cwd: this.projectDir,
      });
      if (res.status !== 0) return 'not_found';
      const status = res.stdout.trim().toLowerCase();
      if (status === 'running') return 'running';
      if (status === 'exited') return 'exited';
      return 'stopped';
    } catch {
      return 'not_found';
    }
  }

  public composeUp(forceRecreate = false): ExecResult {
    const args = [...this.composeArgs(), 'up', '-d'];
    if (forceRecreate) {
      args.push('--force-recreate');
    }
    const res = spawnSync('docker', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }

  public composeDown(): ExecResult {
    const res = spawnSync('docker', [...this.composeArgs(), 'down'], {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }

  public composeRestart(): ExecResult {
    const res = spawnSync('docker', [...this.composeArgs(), 'restart'], {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }

  public getLogs(tail = 100): ExecResult {
    const res = spawnSync('docker', [...this.composeArgs(), 'logs', `--tail=${tail}`, 'mailserver'], {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }

  /**
   * Non-blocking variants for the TUI, where a spawnSync would freeze rendering
   * (compose up --force-recreate can take 30s+).
   */
  public runAsync(args: string[]): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn('docker', args, { cwd: this.projectDir });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr || err.message, success: false }));
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, success: code === 0 }));
    });
  }

  public composeUpAsync(forceRecreate = false): Promise<ExecResult> {
    return this.runAsync([...this.composeArgs(), 'up', '-d', ...(forceRecreate ? ['--force-recreate'] : [])]);
  }

  public composeDownAsync(): Promise<ExecResult> {
    return this.runAsync([...this.composeArgs(), 'down']);
  }

  public composeRestartAsync(): Promise<ExecResult> {
    return this.runAsync([...this.composeArgs(), 'restart']);
  }

  public getLogsAsync(tail = 100): Promise<ExecResult> {
    return this.runAsync([...this.composeArgs(), 'logs', `--tail=${tail}`, 'mailserver']);
  }

  public exec(args: string[]): ExecResult {
    const res = spawnSync('docker', ['exec', 'mailserver', ...args], {
      cwd: this.projectDir,
      encoding: 'utf-8',
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      success: res.status === 0,
    };
  }
}
