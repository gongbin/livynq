/**
 * A tiny value schema used for capability attributes and command parameters.
 * It is deliberately JSON-Schema compatible so the same definition can feed
 * runtime validation, the REST API and MCP tool descriptions.
 */
export type ValueSchema =
  | { type: 'boolean'; description?: string }
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; unit?: string; description?: string }
  | { type: 'string'; enum?: readonly string[]; description?: string }
  | { type: 'object'; properties: Record<string, ValueSchema>; required?: readonly string[]; description?: string }
  | { type: 'null'; description?: string };

export const t = {
  boolean: (description?: string): ValueSchema => ({ type: 'boolean', description }),
  int: (minimum?: number, maximum?: number, extra: { unit?: string; description?: string } = {}): ValueSchema =>
    ({ type: 'integer', minimum, maximum, ...extra }),
  number: (extra: { minimum?: number; maximum?: number; unit?: string; description?: string } = {}): ValueSchema =>
    ({ type: 'number', ...extra }),
  string: (description?: string): ValueSchema => ({ type: 'string', description }),
  enum: (values: readonly string[], description?: string): ValueSchema => ({ type: 'string', enum: values, description }),
  object: (properties: Record<string, ValueSchema>, required: readonly string[] = []): ValueSchema =>
    ({ type: 'object', properties, required }),
  void: (): ValueSchema => ({ type: 'null' }),
};

/** Returns a list of problems; empty means valid. Integers are clamped by callers, not here. */
export function validate(schema: ValueSchema, value: unknown, path = 'value'): string[] {
  switch (schema.type) {
    case 'null':
      return value === undefined || value === null || (typeof value === 'object' && Object.keys(value).length === 0)
        ? []
        : [`${path}: expected no value`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected boolean`];
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return [`${path}: expected ${schema.type}`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path}: expected integer`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path}: must be >= ${schema.minimum}`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path}: must be <= ${schema.maximum}`];
      return [];
    }
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected string`];
      if (schema.enum && !schema.enum.includes(value)) return [`${path}: must be one of ${schema.enum.join(', ')}`];
      return [];
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected object`];
      const obj = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) errors.push(`${path}.${key}: required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const prop = schema.properties[key];
        if (!prop) errors.push(`${path}.${key}: unknown property`);
        else if (v !== undefined) errors.push(...validate(prop, v, `${path}.${key}`));
      }
      return errors;
    }
  }
}
