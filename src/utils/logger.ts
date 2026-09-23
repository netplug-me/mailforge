import chalk from 'chalk';

export const logger = {
  info: (msg: string) => console.log(chalk.cyan('ℹ ') + msg),
  success: (msg: string) => console.log(chalk.green('✔ ') + msg),
  warn: (msg: string) => console.log(chalk.yellow('⚠ ') + msg),
  error: (msg: string) => console.error(chalk.red('✖ ') + msg),
  step: (step: string, msg: string) => console.log(chalk.bold.blue(`[${step}] `) + msg),
  
  header: (title: string, subtitle?: string) => {
    console.log();
    console.log(chalk.bold.cyan(title));
    if (subtitle) {
      console.log(chalk.dim(subtitle));
    }
    console.log(chalk.dim('─'.repeat(Math.max(title.length, subtitle ? subtitle.length : 30))));
  },

  badge: {
    green: (text: string) => chalk.green(`● ${text}`),
    red: (text: string) => chalk.red(`○ ${text}`),
    yellow: (text: string) => chalk.yellow(`▲ ${text}`),
    gray: (text: string) => chalk.dim(`○ ${text}`),
  }
};
