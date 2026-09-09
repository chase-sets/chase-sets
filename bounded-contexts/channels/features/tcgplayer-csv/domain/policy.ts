import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type TcgplayerStagedImportPolicyValue = Readonly<{ maxRowsPerBatch: number }>;

export function decodeTcgplayerStagedImportPolicyValue(raw: JsonValue): TcgplayerStagedImportPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("TCGplayer staged import policy value must be a record.");
  }
  const actual = Object.keys(raw);
  if (actual.length !== 1 || actual[0] !== "maxRowsPerBatch") {
    throw new Error("TCGplayer staged import policy value must contain only maxRowsPerBatch.");
  }
  const value = (raw as Record<string, unknown>).maxRowsPerBatch;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new Error("maxRowsPerBatch must be a safe integer from 1 through 1000000.");
  }
  return { maxRowsPerBatch: value as number };
}

export const tcgplayerStagedImportPolicy: PolicyDefinition<TcgplayerStagedImportPolicyValue> = definePolicy({
  policyKey: "channels.tcgplayer-staged-import",
  contextName: "channels",
  schemaSummary: "{ maxRowsPerBatch: safe integer 1-1000000 }",
  defaultValue: { maxRowsPerBatch: 500 },
  decodeValue: decodeTcgplayerStagedImportPolicyValue,
});
