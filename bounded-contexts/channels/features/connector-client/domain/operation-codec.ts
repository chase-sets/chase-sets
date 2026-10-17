export class OperationProtocolError extends Error {
  constructor(readonly code: "protocol-violation" | "incomplete-authority" | "upgrade-required" | "stale-fence") {
    super(code);
  }
}

export function refuse(): never {
  throw new OperationProtocolError("protocol-violation");
}

export function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const row = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    refuse();
  return row;
}

export function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) refuse();
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) refuse();
  }
}
