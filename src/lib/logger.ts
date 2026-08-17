/**
 * Structured application logger (#563).
 *
 * The codebase carried 81 raw `console.*` calls across 18 non-test modules and
 * exactly one piece of structured logging: an inline object literal at the top
 * of `src/lib/middleware/error-handler.ts` with an `error` and an `info` method,
 * no levels, no way to silence it, and no redaction. Nothing outside
 * `withErrorHandler` used it. Four things followed from that:
 *
 *  - **Debug logging shipped to production.** `src/lib/actions/audit.ts` printed
 *    the built Prisma where-clause — including `query.search`, the raw string the
 *    user typed into the audit filter — on every page load, with no `LOG_LEVEL`
 *    to turn it off.
 *  - **Log injection (CWE-117) was defended per-callsite.** `worker.ts` hand-rolled
 *    `const sanitize = (s) => String(s ?? '').replace(/[\r\n]/g, ' ')` for itself;
 *    every other module interpolated GitHub-supplied repository names and PR
 *    titles straight into template literals, so a repository named
 *    `foo\n[Backend Logger] {"level":"INFO",...}` could forge a log record.
 *  - **Redaction existed but was never applied to logs.** `scrubSensitiveData()`
 *    was applied only to the message returned to the *client*; the `logger.error`
 *    call three lines above it wrote the unredacted message, stack, Prisma `code`
 *    and Prisma `meta` to stdout — which on a hosted log drain is where the
 *    connection string actually ends up.
 *  - **No correlation ID.** A single GitHub delivery fans out across the route,
 *    the BullMQ job, the scanner, the AI flow and the outbound webhook worker
 *    with nothing tying the records together.
 *
 * Dependency-free on purpose. No `pino`, no `winston`: this has to run unchanged
 * in the Next.js server runtime, inside the standalone Docker image, and in the
 * plain `tsx` worker, and a transport that works in one of those and not the
 * others is worse than `console`.
 */

import { scrubCredentials } from '@/lib/redaction';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Numeric severity; a record is emitted when its level is >= the threshold. */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Levels that actually produce output. `silent` is a threshold, not a method. */
export type EmittableLevel = Exclude<LogLevel, 'silent'>;

/**
 * Metadata keys whose values are replaced wholesale.
 *
 * Matched case-insensitively as a substring, so `githubToken`, `AUTH_SECRET` and
 * `x-hub-signature-256` are all caught without enumerating every spelling.
 */
const REDACTED_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'auth',
  'credential',
  'cookie',
  'session',
  'signature',
  'privatekey',
  'private_key',
  'connectionstring',
  'connection_string',
  'database_url',
  'databaseurl',
] as const;

export const REDACTED_PLACEHOLDER = '[REDACTED]';

/** Longest single string value written to a record. */
const MAX_VALUE_LENGTH = 2000;

/** Longest message written to a record. */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * How deep into a metadata object to walk.
 *
 * A whole GitHub webhook payload is nested and large; without a bound, one
 * careless `logger.info('delivery', { payload })` writes megabytes per request.
 */
const MAX_DEPTH = 4;

/** Cap on array entries kept, so a 5,000-file diff cannot become a log line. */
const MAX_ARRAY_ENTRIES = 50;

/**
 * Strip CR and LF from a value destined for a log record.
 *
 * This is the CWE-117 defence, applied centrally instead of once in
 * `worker.ts`. Every log aggregator that splits on newlines treats an embedded
 * `\n` as a record boundary, so an attacker-controlled repository name is
 * otherwise enough to forge an entry.
 *
 * U+2028 and U+2029 are included: some pipelines and JSON parsers treat them as
 * line terminators too. Tabs are kept -- they are not record separators, and
 * they preserve readability in a stack trace.
 */
export function sanitizeLogValue(value: unknown): string {
  return String(value ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** True when a metadata key names something that must never be logged. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_\s]/g, '');
  return REDACTED_KEY_PATTERNS.some((pattern) =>
    normalized.includes(pattern.replace(/[-_]/g, ''))
  );
}

/**
 * Recursively sanitise and redact a metadata value.
 *
 * Handles the three ways this can go wrong in practice: a sensitive key
 * (redacted by name), a value that merely *contains* a credential (scrubbed by
 * `scrubCredentials`, which the client-facing path runs too), and a structure
 * that is too large or self-referential to serialise.
 *
 * Only credentials are scrubbed here, not filesystem paths. Path redaction is
 * right for a message shown to a caller, but in a log record
 * `src/lib/armor/scanner.ts` is the single most useful field there is.
 */
export function redactValue(value: unknown, depth: number = 0, seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const scrubbed = scrubCredentials(sanitizeLogValue(value));
    return scrubbed.length > MAX_VALUE_LENGTH
      ? `${scrubbed.slice(0, MAX_VALUE_LENGTH)}… (truncated)`
      : scrubbed;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubCredentials(sanitizeLogValue(value.message)),
      stack: value.stack ? scrubCredentials(sanitizeLogValue(value.stack)) : undefined,
    };
  }

  if (depth >= MAX_DEPTH) return '[Truncated]';

  const tracker = seen ?? new WeakSet<object>();
  if (typeof value === 'object') {
    // A Prisma error carries request/response objects that reference each other;
    // without this the logger is the thing that crashes.
    if (tracker.has(value as object)) return '[Circular]';
    tracker.add(value as object);
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => redactValue(entry, depth + 1, tracker));
    if (value.length > MAX_ARRAY_ENTRIES) {
      kept.push(`… (${value.length - MAX_ARRAY_ENTRIES} more)`);
    }
    return kept;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED_PLACEHOLDER : redactValue(entry, depth + 1, tracker);
  }
  return out;
}

/** Redact a whole metadata object. */
export function redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!meta) return {};
  return redactValue(meta) as Record<string, unknown>;
}

/**
 * Resolve the active threshold.
 *
 * Under test the threshold is `error`: debug/info/warn are suppressed so
 * `vitest run` is not interleaved with worker and scanner chatter, but errors
 * still surface, because a test that fails silently is worse than a noisy one.
 * `debug` in development, `info` otherwise. An explicit `LOG_LEVEL` always wins,
 * and an unrecognised value falls back rather than accidentally silencing
 * production.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const explicit = env.LOG_LEVEL?.trim().toLowerCase();
  if (explicit && (LOG_LEVELS as readonly string[]).includes(explicit)) {
    return explicit as LogLevel;
  }

  if (env.VITEST === 'true' || env.NODE_ENV === 'test') return 'error';
  if (env.NODE_ENV === 'development') return 'debug';
  return 'info';
}

export function shouldLog(level: EmittableLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

export interface LogRecord {
  timestamp: string;
  level: string;
  message: string;
  [key: string]: unknown;
}

/** Assemble a record. Exported so formatting can be asserted without capturing stdout. */
export function buildRecord(
  level: EmittableLevel,
  message: string,
  meta: Record<string, unknown> | undefined,
  context: Record<string, unknown>,
  now: () => Date = () => new Date()
): LogRecord {
  const text = scrubCredentials(sanitizeLogValue(message));

  return {
    timestamp: now().toISOString(),
    level: level.toUpperCase(),
    message:
      text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}… (truncated)` : text,
    ...redactMeta(context),
    ...redactMeta(meta),
  };
}

/**
 * Render a record.
 *
 * JSON in production so a log drain can index it; a single readable line in
 * development, because a wall of JSON is what makes people reach for
 * `console.log` in the first place.
 */
export function formatRecord(record: LogRecord, pretty: boolean): string {
  if (!pretty) {
    try {
      return JSON.stringify(record);
    } catch {
      // redactValue already breaks cycles, so this is a last resort.
      return JSON.stringify({
        timestamp: record.timestamp,
        level: record.level,
        message: record.message,
        meta: '[Unserializable]',
      });
    }
  }

  const { timestamp, level, message, ...rest } = record;
  const extras = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${timestamp} ${level.padEnd(5)} ${message}${extras}`;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** A logger with additional context bound to every record it writes. */
  child(context: Record<string, unknown>): Logger;
  /** The active threshold, exposed for tests and for guarding expensive metadata. */
  level: LogLevel;
}

export interface LoggerOptions {
  level?: LogLevel;
  pretty?: boolean;
  context?: Record<string, unknown>;
  /** Injectable sink, so tests never touch the real console. */
  sink?: (level: EmittableLevel, line: string) => void;
  now?: () => Date;
}

function defaultSink(level: EmittableLevel, line: string): void {
  // `console.error` for warn and error so they land on stderr, which is what
  // Render and Docker use to separate the two streams.
  if (level === 'error' || level === 'warn') console.error(line);
  else if (level === 'debug') console.debug(line);
  else console.info(line);
}

/**
 * Build a logger.
 *
 * `level` and `pretty` are resolved once at construction: reading `process.env`
 * per call would be a measurable cost on the worker's hot path, and the
 * environment does not change under a running process.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? resolveLogLevel();
  const pretty = options.pretty ?? process.env.NODE_ENV !== 'production';
  const context = options.context ?? {};
  const sink = options.sink ?? defaultSink;
  const now = options.now;

  const emit = (emittable: EmittableLevel, message: string, meta?: Record<string, unknown>) => {
    if (!shouldLog(emittable, level)) return;
    sink(emittable, formatRecord(buildRecord(emittable, message, meta, context, now), pretty));
  };

  return {
    level,
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (extra) =>
      createLogger({ ...options, level, pretty, context: { ...context, ...extra } }),
  };
}

/**
 * Process-wide logger.
 *
 * `logger.child({ deliveryId })` in the worker gives every record from one
 * GitHub delivery the same correlation handle for free.
 */
export const logger = createLogger();

export default logger;
