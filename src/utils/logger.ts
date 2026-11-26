/**
 * Logger utility: console output plus an optional log file
 */

import { appendFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { dirname } from 'path';
import { inspect } from 'util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private level: LogLevel = 'info';
  private filePath: string | null = null;
  private readonly levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Also write log lines to a file. With `rotate`, the previous log is kept as `<name>.old.log`.
   * The file always receives debug lines, regardless of the console level.
   */
  setLogFile(path: string, { rotate = true }: { rotate?: boolean } = {}): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (rotate && existsSync(path)) {
        renameSync(path, path.replace(/\.log$/, '.old.log'));
      }
      this.filePath = path;
    } catch (err) {
      this.filePath = null;
      this.warn(`Unable to write log file ${path}: ${String(err)}`);
    }
  }

  getLogFile(): string | null {
    return this.filePath;
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    const extra = args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' ');
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${extra ? ` ${extra}` : ''}`;

    if (this.levels[level] >= this.levels[this.level]) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + '\n');
      } catch {
        // Ignore log file errors
      }
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }
}

export const logger = new Logger();

// Enable debug console logging if DEBUG env var is set
if (process.env.DEBUG) {
  logger.setLevel('debug');
}
