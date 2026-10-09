export class AuditSanitizer {
  /**
   * Safely serializes rich metadata types (Date, Map, Set) into JSON-compatible strings
   * to prevent data stripping during database writes.
   */
  static serializePayload(payload: any): string {
    // A `function`, not an arrow, so `this` is the object holding `key`.
    // `JSON.stringify` calls `toJSON()` before the replacer runs, so for a Date
    // `value` is already its ISO string (or null for an Invalid Date), so a
    // `value instanceof Date` check never matched and Dates came back as plain
    // strings. `this[key]` is the original, unconverted value.
    return JSON.stringify(payload, function (this: any, key, value) {
      const original = this[key];
      if (original instanceof Date) {
        return { _type: "Date", value };
      }
      if (value instanceof Map) {
        return { _type: "Map", entries: Array.from(value.entries()) };
      }
      if (value instanceof Set) {
        return { _type: "Set", entries: Array.from(value.values()) };
      }
      return value;
    });
  }

  static deserializePayload(payloadString: string): any {
    return JSON.parse(payloadString, (key, value) => {
      if (value && typeof value === "object") {
        if (value._type === "Map") return new Map(value.entries);
        if (value._type === "Set") return new Set(value.entries);
        if (value._type === "Date") return new Date(value.value ?? NaN);
      }
      return value;
    });
  }
}
