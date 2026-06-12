export type JsonPrimitive = string | number | boolean | null | undefined;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export function toJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}
