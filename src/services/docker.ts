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
