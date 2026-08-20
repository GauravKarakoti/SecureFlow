/**
 * The secret-logging detector, separated from the CLI shell.
 *
 * Everything here is pure: it takes text and returns violations. The process
 * exit, the git calls and the console output live in `./index` and `./git`, so
 * the part that decides whether a commit is blocked can actually be tested
 * (#593).
 */

/** One flagged call site. */
export interface Violation {
  /** 1-based line of the `console.*` call. */
  line: number;
  /** The source line as written, for the report. */
  text: string;
  /** Which indicator matched, so the message can say why. */
  reason: string;
}

/** Console methods that put their arguments somewhere durable. */
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir'];

/**
 * Start of a console call. Whitespace is permitted around the dot and the
 * parenthesis because a formatter will put it there.
 */
const CONSOLE_CALL = new RegExp(
  `console\\s*\\.\\s*(?:${CONSOLE_METHODS.join('|')})\\s*\\(`,
  'g',
);

/**
 * What makes an argument list suspicious.
 *
 * Checked against the *masked* source, so a string literal that merely contains
 * the word "password" does not match — only an identifier or a member
 * expression does.
 */
const INDICATORS: ReadonlyArray<readonly [string, RegExp]> = [
  ['environment variable', /\b(?:process\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env|Deno\s*\.\s*env|os\s*\.\s*environ)\b/],
  ['secret-named identifier', /\b\w*(?:password|passwd|secret|token|credential|apikey|privatekey)\w*\b/i],
  // `key` and `auth` on their own are common enough in ordinary code
  // (`keyof`, `authorised`, `keys`) that they are only flagged when they read
  // as a whole word or as an obvious compound.
  ['secret-named identifier', /\b(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|authorization)\b/i],
];

/** Extensions never worth scanning as source text. */
const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.webm',
  '.so', '.dylib', '.dll', '.exe', '.wasm', '.class', '.jar',
  '.sqlite', '.db',
];

/** Generated files that are large, uninteresting, and full of hashes. */
const GENERATED_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'composer.lock',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock',
];

/**
 * Bytes above which a staged blob is skipped.
 *
 * Nothing bounded this before, so a staged fixture or a vendored bundle was
 * read into memory and scanned line by line.
 */
export const MAX_SCANNED_BYTES = 512 * 1024;

/** Whether `path` should be scanned at all. */
export function shouldScanFile(path: string, byteLength?: number): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split('/').pop() ?? lower;

  if (GENERATED_FILES.some((name) => basename === name.toLowerCase())) return false;
  if (BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  if (typeof byteLength === 'number' && byteLength > MAX_SCANNED_BYTES) return false;

  return true;
}

/**
 * Heuristic for content that is binary despite its name.
 *
 * A NUL byte does not occur in text. Checking this beats trusting the
 * extension, since a staged blob can be anything.
 */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000');
}

/** Filler used where a string literal's contents were. */
const MASK_CHAR = '·';

/**
 * Blank out the *contents* of string literals, preserving length.
 *
 * The previous implementation deleted them outright:
 *
 *     trimmedLine.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '')
 *
 * which turned `` console.log(`token: ${authToken}`) `` into `console.log()` —
 * the interpolation went with the quotes, so the single most common way a
 * secret reaches a log line became invisible. Deleting also shifts every column
 * after it, which matters now that whole files are scanned rather than
 * individual lines.
 *
 * Interpolations inside a template literal are left intact, because
 * `${authToken}` is code, not text. Escapes are honoured so a `\"` does not end
 * a literal, and an unterminated quote stops at the newline rather than eating
 * the rest of the file.
 */
export function maskStringLiterals(source: string): string {
  const out = source.split('');
  let index = 0;

  while (index < out.length) {
    const char = out[index];

    // Line comments are masked, not merely skipped over: skipping advances the
    // cursor but leaves the text in the output, so the commented-out code was
    // still scanned. The old detector only handled `//` at the very start of a
    // trimmed line, so a trailing comment was scanned as code either way.
    if (char === '/' && out[index + 1] === '/') {
      while (index < out.length && out[index] !== '\n') {
        out[index] = MASK_CHAR;
        index += 1;
      }
      continue;
    }

    if (char === '/' && out[index + 1] === '*') {
      index += 2;
      while (index < out.length && !(out[index] === '*' && out[index + 1] === '/')) {
        if (out[index] !== '\n') out[index] = MASK_CHAR;
        index += 1;
      }
      index += 2;
      continue;
    }

    if (char !== '"' && char !== "'" && char !== '`') {
      index += 1;
      continue;
    }

    const quote = char;
    index += 1;

    while (index < out.length) {
      const current = out[index];

      if (current === '\\') {
        // Escaped character: mask both, and never let it terminate the literal.
        if (out[index] !== '\n') out[index] = MASK_CHAR;
        if (index + 1 < out.length && out[index + 1] !== '\n') out[index + 1] = MASK_CHAR;
        index += 2;
        continue;
      }

      if (current === quote) {
        index += 1;
        break;
      }

      // An unterminated quote must not swallow the rest of the file. Only a
      // template literal legally spans lines.
      if (current === '\n' && quote !== '`') break;

      // `${ … }` inside a template literal is code. Leave it visible, tracking
      // brace depth so a nested object literal does not end it early.
      if (quote === '`' && current === '$' && out[index + 1] === '{') {
        let depth = 1;
        index += 2;
        while (index < out.length && depth > 0) {
          if (out[index] === '{') depth += 1;
          else if (out[index] === '}') depth -= 1;
          index += 1;
        }
        continue;
      }

      if (current !== '\n') out[index] = MASK_CHAR;
      index += 1;
    }
  }

  return out.join('');
}

/**
 * Text of the balanced argument list starting at `openParen`, or null when the
 * parenthesis is never closed.
 *
 * Scanning for the matching parenthesis rather than matching a regex is what
 * makes a wrapped call detectable. The old detector tested one line at a time,
 * so the `[\s\S]*?` in its pattern could never span anything and
 *
 *     console.log(
 *       'db password:',
 *       process.env.DB_PASSWORD
 *     );
 *
 * — the shape Prettier produces at default print width — went unflagged.
 */
export function readArgumentList(source: string, openParen: number): string | null {
  let depth = 0;

  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, i);
    }
  }

  return null;
}

/** 1-based line number of `offset`. */
export function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Find every `console.*` call whose arguments reference a secret.
 *
 * Operates on the whole file, not line by line, so a call split across lines is
 * matched. The reported line is the line the call *starts* on, which is where a
 * reader will look.
 */
export function findSecretLogging(source: string): Violation[] {
  if (!source) return [];

  const masked = maskStringLiterals(source);
  const lines = source.split(/\r?\n/);
  const violations: Violation[] = [];

  CONSOLE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CONSOLE_CALL.exec(masked)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const args = readArgumentList(masked, openParen);
    if (args === null) continue;

    const indicator = INDICATORS.find(([, pattern]) => pattern.test(args));
    if (!indicator) continue;

    const line = lineOf(masked, match.index);
    violations.push({
      line,
      text: (lines[line - 1] ?? '').trim(),
      reason: indicator[0],
    });
  }

  return violations;
}

/** Result of scanning one staged file. */
export interface FileScanResult {
  path: string;
  violations: Violation[];
  /** Set when the file was not scanned, with the reason. */
  skipped?: string;
}

/** Scan one staged blob. */
export function scanFile(path: string, content: string): FileScanResult {
  if (!shouldScanFile(path, Buffer.byteLength(content, 'utf-8'))) {
    return { path, violations: [], skipped: 'excluded by type or size' };
  }

  if (looksBinary(content)) {
    return { path, violations: [], skipped: 'binary content' };
  }

  return { path, violations: findSecretLogging(content) };
}
