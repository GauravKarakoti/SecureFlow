export class AuditSanitizer {
  /**
   * Safely serializes rich metadata types (Date, Map, Set) into JSON-compatible strings
   * to prevent data stripping during database writes.
   */
  static serializePayload(payload: any): string {
    return JSON.stringify(payload, (key, value) => {
      if (value instanceof Map) {
        return { _type: 'Map', entries: Array.from(value.entries()) };
      }
      if (value instanceof Set) {
        return { _type: 'Set', entries: Array.from(value.values()) };
      }
      if (value instanceof Date) {
        return { _type: 'Date', value: value.toISOString() };
      }
      return value;
    });
  }

  static deserializePayload(payloadString: string): any {
    return JSON.parse(payloadString, (key, value) => {
      if (value && typeof value === 'object') {
        if (value._type === 'Map') return new Map(value.entries);
        if (value._type === 'Set') return new Set(value.entries);
        if (value._type === 'Date') return new Date(value.value);
      }
      return value;
    });
  }
}
