/**
 * Opaque cursor pagination utilities for stable (createdAt, id) ordered queries.
 */

export interface DecodedCursor {
  createdAt: Date;
  id: string;
}

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Encodes an item with a date (createdAt or timestamp) and an id into a URL-safe base64 opaque cursor string.
 */
export function encodeCursor(item: {
  createdAt?: Date | string;
  timestamp?: Date | string;
  id: string;
}): string {
  const rawDate = item.createdAt ?? item.timestamp;
  const dateStr =
    rawDate instanceof Date ? rawDate.toISOString() : new Date(rawDate ?? Date.now()).toISOString();
  return Buffer.from(JSON.stringify({ createdAt: dateStr, id: item.id })).toString("base64url");
}

/**
 * Decodes a URL-safe base64 opaque cursor string back into a Date and ID.
 * Returns null if the cursor is malformed or invalid.
 */
export function decodeCursor(cursorStr?: string | null): DecodedCursor | null {
  if (!cursorStr || typeof cursorStr !== "string") return null;
  try {
    const raw = Buffer.from(cursorStr, "base64url").toString("utf-8");
    const parsed = JSON.parse(raw);
    const dateVal = parsed.createdAt ?? parsed.timestamp;
    if (!parsed.id || !dateVal) return null;
    const date = new Date(dateVal);
    if (Number.isNaN(date.getTime())) return null;
    return { createdAt: date, id: String(parsed.id) };
  } catch {
    return null;
  }
}

/**
 * Parse and clamp a limit query parameter with a sane default and maximum.
 */
export function parseLimit(
  value: string | number | null | undefined,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
  maxLimit: number = MAX_PAGE_LIMIT,
): number {
  if (value === null || value === undefined || value === "") return defaultLimit;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return Math.min(Math.floor(parsed), maxLimit);
}

/**
 * Builds the keyset condition for querying strictly older rows than the cursor:
 * (date < cursor.date) OR (date == cursor.date AND id < cursor.id)
 */
export function buildCursorWhere(
  cursor: DecodedCursor | null,
  field: "createdAt" | "timestamp" = "createdAt",
) {
  if (!cursor) return {};
  return {
    OR: [
      { [field]: { lt: cursor.createdAt } },
      {
        AND: [{ [field]: cursor.createdAt }, { id: { lt: cursor.id } }],
      },
    ],
  };
}
