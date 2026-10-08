#!/usr/bin/env node

import { Command } from 'commander';
import { registerCommands } from './cli/commands.js';
import { startTui } from './tui/app.js';

const program = new Command();

program
  .name('mailforge')
  .description('Docker Mailserver & Cloudflare DNS Manager with Interactive TUI')
  .version('1.0.0');

registerCommands(program);

// If no arguments provided, launch the interactive TUI
if (process.argv.length <= 2) {
  startTui().catch((err) => {
    console.error('Fatal error in TUI:', err);
    process.exit(1);
  });
} else {
  program.parseAsync(process.argv).catch((err) => {
    console.error('Command failed:', err);
    process.exit(1);
  });
}
