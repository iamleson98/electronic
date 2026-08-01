// Input sanitization helpers for the saved-circuit API routes.
// ─────────────────────────────────────────────────────────────────────────────
// Both POST (create) and PUT (update) need to clamp string lengths and
// normalize the `document` field. Centralizing this here keeps the route
// handlers thin and the validation rules in one place.

/** Maximum field lengths — protects against accidental huge payloads. */
export const LIMITS = {
  name: 200,
  description: 1000,
  tags: 500,
} as const;

/** Clamp a string to `max` characters. Returns `''` for nullish input. */
function clamp(value: unknown, max: number): string {
  return String(value ?? '').slice(0, max);
}

/**
 * Build the `values` object for an INSERT from raw request body.
 * `name` and `document` are required; the rest are optional with defaults.
 */
export function toCreateValues(body: {
  name?: string;
  description?: string;
  document?: unknown;
  tags?: string;
  isExample?: boolean;
}) {
  return {
    name: clamp(body.name, LIMITS.name),
    description: clamp(body.description, LIMITS.description),
    document: normalizeDocument(body.document),
    tags: clamp(body.tags, LIMITS.tags),
    isExample: !!body.isExample,
  };
}

/**
 * Build the partial `set` object for an UPDATE from raw request body.
 * Only fields that are present (not `undefined`) are included, so omitted
 * fields are left untouched.
 */
export function toUpdateValues(body: {
  name?: string;
  description?: string;
  document?: unknown;
  tags?: string;
  isExample?: boolean;
}): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = clamp(body.name, LIMITS.name);
  if (body.description !== undefined) updates.description = clamp(body.description, LIMITS.description);
  if (body.document !== undefined) updates.document = normalizeDocument(body.document);
  if (body.tags !== undefined) updates.tags = clamp(body.tags, LIMITS.tags);
  if (body.isExample !== undefined) updates.isExample = !!body.isExample;
  return updates;
}

/** Accept a JSON string as-is, or stringify a structured `document` object. */
function normalizeDocument(document: unknown): string {
  return typeof document === 'string' ? document : JSON.stringify(document ?? {});
}
