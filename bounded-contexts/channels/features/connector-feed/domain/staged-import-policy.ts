import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { decodeStagedImportDispatchPolicy, stagedImportDispatchPolicyKey } from "./staged-import-dispatch-policy";

export const tcgplayerStagedImportDispatchPolicy = definePolicy({
  policyKey: stagedImportDispatchPolicyKey,
  contextName: "channels",
  schemaSummary:
    "TcgplayerStagedImportDispatchPolicy/v1 { minimumRequestStartIntervalSeconds: integer 60..600 seconds }; engineering bound, not provider capacity",
  defaultValue: { minimumRequestStartIntervalSeconds: 60 },
  decodeValue: decodeStagedImportDispatchPolicy,
});
