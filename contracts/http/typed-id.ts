import { parseTypedId, type TypedUlid } from "@chase-sets/primitives/typed-ids";
import { validationFailedResponse, type ApiErrorResponse } from "./responses";

export class TypedIdBoundaryDomainError extends Error {
  override readonly name = "TypedIdBoundaryDomainError";
  readonly status = 400 as const;
  readonly body: ApiErrorResponse;

  constructor(fieldName: string, prefix: string) {
    const message = `${fieldName} must start with ${prefix}_.`;
    const body = validationFailedResponse(message, [
      {
        field: fieldName,
        code: "invalid_id_prefix",
        message: `Expected an ID starting with ${prefix}_.`,
      },
    ]);
    super(message);
    this.body = body;
  }
}

export function parseTypedIdBoundary<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  fieldName = "id",
): TypedUlid<Prefix> {
  const normalized = typeof value === "string" ? value.trim() : "";

  try {
    return parseTypedId(normalized, prefix);
  } catch {
    throw new TypedIdBoundaryDomainError(fieldName, prefix);
  }
}

export function parseOptionalTypedIdBoundary<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  fieldName = "id",
): TypedUlid<Prefix> | undefined {
  return value === undefined || value === null || value === ""
    ? undefined
    : parseTypedIdBoundary(value, prefix, fieldName);
}

export function parseTypedIdArrayBoundary<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  fieldName: string,
): TypedUlid<Prefix>[] {
  if (!Array.isArray(value)) {
    throw new TypedIdBoundaryDomainError(fieldName, prefix);
  }

  return value.map((item, index) => parseTypedIdBoundary(item, prefix, `${fieldName}[${index}]`));
}
