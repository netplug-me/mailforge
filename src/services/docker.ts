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
    const args = ['compose', 'up', '-d'];
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
    const res = spawnSync('docker', ['compose', 'down'], {
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
    const res = spawnSync('docker', ['compose', 'restart'], {
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
    const res = spawnSync('docker', ['compose', 'logs', `--tail=${tail}`, 'mailserver'], {
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
    return this.runAsync(['compose', 'up', '-d', ...(forceRecreate ? ['--force-recreate'] : [])]);
  }

  public composeDownAsync(): Promise<ExecResult> {
    return this.runAsync(['compose', 'down']);
  }

  public composeRestartAsync(): Promise<ExecResult> {
    return this.runAsync(['compose', 'restart']);
  }

  public getLogsAsync(tail = 100): Promise<ExecResult> {
    return this.runAsync(['compose', 'logs', `--tail=${tail}`, 'mailserver']);
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
