/**
 * Text redaction shared by the error handler and the logger (#563).
 *
 * `scrubSensitiveData` lived in `src/lib/middleware/error-handler.ts` and was
 * applied to exactly one thing: the message returned to the client. The
 * `logger.error(...)` call three lines above it wrote the *unredacted* message,
 * stack, Prisma `code` and Prisma `meta` to stdout — which, on a hosted log
 * drain, is where the connection string actually ends up.
 *
 * Extracting it here lets both paths share it without `error-handler.ts` and
 * `logger.ts` importing each other. `error-handler.ts` re-exports
 * `scrubSensitiveData` unchanged, so nothing that imports it from there breaks.
 *
 * The split into two functions is the substantive part. Path redaction is right
 * for a client-facing message — a caller has no business learning our directory
 * layout — but actively harmful in a log, where `src/lib/armor/scanner.ts` is
 * the most useful thing in the record. The logger therefore applies only
 * {@link scrubCredentials}.
 */

/**
 * Remove credentials from free text.
 *
 * Covers the three shapes that actually show up in this codebase's failures:
 * a Postgres/Redis URL with an inline password, any other `scheme://user:pass@`
 * authority, and a `SOMETHING_SECRET=value` pair from an environment dump.
 */
export function scrubCredentials(text: string): string {
  if (!text) return text;
  let sanitized = text;

  // postgresql://user:password@host/db — the shape a Prisma connection error
  // puts straight into its message.
  sanitized = sanitized.replace(
    /[a-zA-Z]+:\/\/[^/\s]+:[^/\s]+@[^\s]+/g,
    '[REDACTED_CONNECTION_STRING]'
  );

  // Any remaining userinfo in a URL authority.
  sanitized = sanitized.replace(/:\/\/[^@\s]+@/g, '://[REDACTED_CREDENTIALS]@');

  // GITHUB_CLIENT_SECRET=..., authToken = ..., etc.
  sanitized = sanitized.replace(
    /[\w.-]*(?:key|secret|token|password|auth|db_url|database_url)[\w.-]*\s*=\s*[^\s]+/gi,
    '[REDACTED_SECRET]'
  );

  return sanitized;
}

/**
 * Remove absolute filesystem paths from free text.
 *
 * Applied to client-facing messages only. A stack trace returned to a caller
 * otherwise advertises the deployment's directory layout and, on a developer
 * machine, the developer's home directory name.
 */
export function scrubFilesystemPaths(text: string): string {
  if (!text) return text;
  let sanitized = text;

  // Windows: D:\Struggle\Open Source\SecureFlow\...
  sanitized = sanitized.replace(/[a-zA-Z]:\\[\\\w\s.-]+/g, '[REDACTED_PATH]');
  // Unix: /usr/local/bin/... — anchored on a leading slash, so a repository
  // -relative path such as `src/db.ts` is left alone.
  sanitized = sanitized.replace(/\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, '[REDACTED_PATH]');

  return sanitized;
}

/**
 * Full scrub for anything crossing the boundary to a client.
 *
 * Behaviour is identical to the previous implementation in `error-handler.ts`;
 * only the location changed.
 */
export function scrubSensitiveData(text: string): string {
  if (!text) return text;
  return scrubFilesystemPaths(scrubCredentials(text));
}
