import fixture from "./provider-object-disposition-option-b.fixture.json" with { type: "json" };
import { OPTION_B_CLASS_TABLE, validateProviderObjectDisposition } from "./validate-provider-object-disposition.mjs";
import { computeResultDigest } from "./canonicalize-provider-object-disposition.mjs";

export const DISPOSITION_RECEIPT_POLICY = Object.freeze({
  version: fixture.scenarios.success.version,
  classTable: OPTION_B_CLASS_TABLE,
  computeResultDigest,
  validateProviderObjectDisposition,
});
