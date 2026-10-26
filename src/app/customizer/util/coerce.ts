/** Attribute-style boolean: absent/false -> false; empty string / true / any other string except "false" -> true. */
export function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return value === true;
}

/** Accepts an array, a comma/space separated string (attribute form) or nothing. */
export function coerceStringList(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && !!v);
  if (typeof value === 'string')
    return value
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}
