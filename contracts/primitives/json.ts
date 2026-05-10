export type JsonPrimitive = string | number | boolean | null | undefined;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
