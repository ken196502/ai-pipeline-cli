/**
 * Structured Per-Run Logger.
 *
 * Persists timestamped, leveled logs into a `.log` file and a `.jsonl` file
 * while optionally mirroring to console and progress callbacks.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'DEBUG' | 'INFO' | 'STAGE' | 'EVENT' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  stage?: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface JsonlLogEntry {
  runId: string;
  timestamp: string;
  level: LogLevel;
  stage?: string;
  message: string;
  event?: string;
  meta?: Record<string, unknown>;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    [key: string]: unknown;
  };
}

export interface RunLoggerOptions {
  runId: string;
  logDir: string;
  title?: string;
  logFileName?: string;
  jsonlFileName?: string;
  consoleOutput?: boolean;
  onLog?: (entry: LogEntry) => void;
}

export class RunLogger {
  readonly runId: string;
  readonly logFilePath: string;
  readonly jsonlLogFilePath: string;
  private readonly stream: fs.WriteStream;
  private readonly jsonlStream: fs.WriteStream;
  private readonly consoleOutput: boolean;
  private readonly onLog?: (entry: LogEntry) => void;
  private currentStage: string = 'init';

  constructor(options: RunLoggerOptions) {
    this.runId = options.runId;
    this.consoleOutput = options.consoleOutput ?? false;
    this.onLog = options.onLog;

    const fileName = options.logFileName || 'pipeline.log';
    const jsonlFileName = options.jsonlFileName || 'events.jsonl';
    this.logFilePath = path.join(options.logDir, fileName);
    this.jsonlLogFilePath = path.join(options.logDir, jsonlFileName);

    fs.mkdirSync(options.logDir, { recursive: true });
    this.stream = fs.createWriteStream(this.logFilePath, {
      flags: 'a',
      encoding: 'utf-8',
    });
    this.jsonlStream = fs.createWriteStream(this.jsonlLogFilePath, {
      flags: 'a',
      encoding: 'utf-8',
    });

    this.stream.on('error', (err) => {
      console.warn(`[RunLogger] Stream error on ${this.logFilePath}: ${err.message}`);
    });
    this.jsonlStream.on('error', (err) => {
      console.warn(`[RunLogger] Stream error on ${this.jsonlLogFilePath}: ${err.message}`);
    });

    this.writeHeader(options.title || 'RUN LOG');
  }

  private safeWrite(stream: fs.WriteStream, data: string): void {
    if (!stream.destroyed && stream.writable) {
      try {
        stream.write(data);
      } catch (err: any) {
        console.warn(`[RunLogger] Write error: ${err.message}`);
      }
    }
  }

  private writeHeader(title: string): void {
    const banner = [
      '================================================================================',
      `${title} - [Run ID: ${this.runId}]`,
      `Started At: ${new Date().toISOString()}`,
      `Log File:   ${this.logFilePath}`,
      `JSONL File: ${this.jsonlLogFilePath}`,
      '================================================================================',
      '',
    ].join('\n');

    this.safeWrite(this.stream, banner);
  }

  setStage(stage: string): void {
    this.currentStage = stage;
  }

  getStage(): string {
    return this.currentStage;
  }

  getArtifacts(): { logFilePath: string; jsonlLogFilePath: string } {
    return {
      logFilePath: this.logFilePath,
      jsonlLogFilePath: this.jsonlLogFilePath,
    };
  }

  log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    error?: JsonlLogEntry['error'],
    eventName?: string,
  ): void {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      stage: this.currentStage,
      message,
      meta,
    };

    const stageTag = this.currentStage ? `[${this.currentStage}]` : '';
    const eventTag = eventName ? `<${eventName}> ` : '';
    const metaSuffix = meta && Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
    const line = `[${timestamp}] [${level.padEnd(5)}] ${stageTag.padEnd(16)} ${eventTag}${message}${metaSuffix}\n`;

    this.safeWrite(this.stream, line);

    const jsonlEntry: JsonlLogEntry = {
      runId: this.runId,
      timestamp,
      level,
      stage: this.currentStage,
      message,
      ...(eventName ? { event: eventName } : {}),
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
      ...(error ? { error } : {}),
    };
    this.safeWrite(this.jsonlStream, JSON.stringify(jsonlEntry) + '\n');

    if (this.onLog) {
      try {
        this.onLog(entry);
      } catch {
        // Ignore subscriber errors
      }
    }

    if (this.consoleOutput) {
      const consoleMsg = `[${level}] [${this.currentStage}] ${eventTag}${message}`;
      if (level === 'ERROR') {
        console.error(consoleMsg, meta || '');
      } else if (level === 'WARN') {
        console.warn(consoleMsg, meta || '');
      } else {
        console.log(consoleMsg, meta || '');
      }
    }
  }

  stage(stageName: string, message: string, meta?: Record<string, unknown>): void {
    this.setStage(stageName);
    this.log('STAGE', message, meta);
  }

  event(eventName: string, data?: Record<string, unknown>): void {
    this.log('EVENT', `Event emitted: ${eventName}`, data, undefined, eventName);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('WARN', message, meta);
  }

  error(message: string, err?: unknown, meta?: Record<string, unknown>): void {
    const errorDetails: Record<string, unknown> = { ...(meta || {}) };
    let structuredError: JsonlLogEntry['error'] | undefined;
    if (err instanceof Error) {
      errorDetails.errorName = err.name;
      errorDetails.errorMessage = err.message;
      if (err.stack) {
        errorDetails.stack = err.stack.split('\n').slice(0, 5).join(' -> ');
      }
      structuredError = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    } else if (err !== undefined) {
      errorDetails.rawError = String(err);
      structuredError = {
        message: String(err),
      };
    }
    this.log('ERROR', message, errorDetails, structuredError);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('DEBUG', message, meta);
  }

  async close(): Promise<void> {
    const footer = [
      '',
      '================================================================================',
      `RUN COMPLETED - [Run ID: ${this.runId}] at ${new Date().toISOString()}`,
      '================================================================================\n',
    ].join('\n');

    this.safeWrite(this.stream, footer);

    return new Promise((resolve) => {
      let pending = 2;
      const onDone = () => {
        pending -= 1;
        if (pending <= 0) resolve();
      };
      if (this.stream.destroyed || !this.stream.writable) {
        pending -= 1;
      } else {
        this.stream.end(onDone);
      }
      if (this.jsonlStream.destroyed || !this.jsonlStream.writable) {
        pending -= 1;
      } else {
        this.jsonlStream.end(onDone);
      }
      if (pending <= 0) {
        resolve();
      }
    });
  }
}

let activeRunLogger: RunLogger | null = null;

export function getActiveRunLogger(): RunLogger | null {
  return activeRunLogger;
}

export function setActiveRunLogger(logger: RunLogger | null): void {
  activeRunLogger = logger;
}

export function createRunLogger(options: RunLoggerOptions): RunLogger {
  const logger = new RunLogger(options);
  activeRunLogger = logger;
  return logger;
}
