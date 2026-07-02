import { getOptionalEnv } from "@chase-sets/platform-runtime/config-schema";

export function loadExampleConfig() {
  return {
    documented: getOptionalEnv("DOCUMENTED_IN_EXAMPLE"),
    missing: getOptionalEnv("MISSING_FROM_EXAMPLE"),
  };
}
