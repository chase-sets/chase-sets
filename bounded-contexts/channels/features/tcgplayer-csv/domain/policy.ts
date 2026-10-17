import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";

export type TcgplayerStagedImportPolicyValue = Readonly<{ maxRowsPerBatch: number }>;

export function decodeTcgplayerStagedImportPolicyValue(raw: JsonValue): TcgplayerStagedImportPolicyValue {
  if (!isJsonObject(raw)) {
    throw new Error("TCGplayer staged import policy value must be a record.");
  }
  const actual = Object.keys(raw);
  if (actual.length !== 1 || actual[0] !== "maxRowsPerBatch") {
    throw new Error("TCGplayer staged import policy value must contain only maxRowsPerBatch.");
  }
  const value = raw.maxRowsPerBatch;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error("maxRowsPerBatch must be a safe integer from 1 through 1000000.");
  }
  return { maxRowsPerBatch: value };
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const tcgplayerStagedImportPolicy: PolicyDefinition<TcgplayerStagedImportPolicyValue> = definePolicy({
  policyKey: "channels.tcgplayer-staged-import",
  contextName: "channels",
  schemaSummary: "{ maxRowsPerBatch: safe integer 1-1000000 }",
  defaultValue: { maxRowsPerBatch: 500 },
  decodeValue: decodeTcgplayerStagedImportPolicyValue,
});
