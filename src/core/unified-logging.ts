import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { format } from 'node:util';

type Level = 'debug' | 'info' | 'warn' | 'error';

function expandHome(path: string): string {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function serializeLine(level: Level, args: unknown[]): string {
  const msg = format(...(args as any[]));
  return `[${new Date().toISOString()}] ${level.toUpperCase()}: ${msg}\n`;
}

export type UnifiedLoggingHandle = {
  filePath: string;
  uninstall: () => void;
};

/**
 * Mirror all console output (log/warn/error/debug) into a single file.
 * This catches Logger output (which uses console.log) plus ad-hoc console usage.
 */
export function installConsoleFileMirror(params: { filePath: string }): UnifiedLoggingHandle {
  const filePath = expandHome(params.filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: 'a' });

  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
  };

  const write = (level: Level, args: unknown[]) => {
    try {
      stream.write(serializeLine(level, args));
    } catch {
      // Best-effort only.
    }
  };

  console.log = (...args: unknown[]) => {
    write('info', args);
    original.log(...(args as any[]));
  };
  console.warn = (...args: unknown[]) => {
    write('warn', args);
    original.warn(...(args as any[]));
  };
  console.error = (...args: unknown[]) => {
    write('error', args);
    original.error(...(args as any[]));
  };
  console.debug = (...args: unknown[]) => {
    write('debug', args);
    original.debug(...(args as any[]));
  };

  const onUnhandledRejection = (reason: unknown) => {
    console.error('unhandledRejection', reason);
  };
  const onUncaughtException = (err: unknown) => {
    console.error('uncaughtException', err);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return {
    filePath,
    uninstall: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      console.debug = original.debug as any;
      process.off('unhandledRejection', onUnhandledRejection);
      process.off('uncaughtException', onUncaughtException);
      try {
        stream.end();
      } catch {
        // ignore
      }
    },
  };
}

