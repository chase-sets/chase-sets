import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REQUIRED_CONFIRM_TEXT as CHECKOUT_ORDER_READINESS_TRACE_CONFIRM } from "./checkout-order-readiness-trace.mjs";
import { EASYPOST_REFUND_EVENT_REPLAY_CONFIRM } from "./easypost-refund-event-replay.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptsDir);

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("operator confirm phrases", () => {
  it("keeps EasyPost replay workflow instructions aligned with the script confirm phrase", () => {
    const workflow = readRepoFile(".github/workflows/marketplace-easypost-refund-event-replay.yml");

    expect(workflow).toContain(`Type "${EASYPOST_REFUND_EVENT_REPLAY_CONFIRM}" only when mode is replay.`);
  });

  it("keeps checkout order-readiness trace workflow instructions aligned with the script confirm phrase", () => {
    const workflow = readRepoFile(".github/workflows/checkout-order-readiness-trace.yml");

    expect(workflow).toContain(`Type "${CHECKOUT_ORDER_READINESS_TRACE_CONFIRM}" to confirm staging-only read access.`);
    expect(workflow).toContain(`inputs.confirm != '${CHECKOUT_ORDER_READINESS_TRACE_CONFIRM}'`);
  });

  it("keeps both staging reset modes aligned with their exact confirm phrases", () => {
    const workflow = readRepoFile(".github/workflows/platform-staging-reset.yml");
    const modeConfirmPhrases = new Map([
      ["full-reset", "reset staging"],
      ["resume-recreate", "resume staging recreate"],
    ]);

    expect(workflow).toContain("RESET_MODE: ${{ inputs.mode }}");
    expect(workflow).toContain("RESET_CONFIRM: ${{ inputs.confirm }}");
    for (const [mode, confirmPhrase] of modeConfirmPhrases) {
      expect(workflow).toContain(`${mode})`);
      expect(workflow).toContain(`if [ "$RESET_CONFIRM" != "${confirmPhrase}" ]; then`);
      expect(workflow).toContain(`Confirmation input must exactly equal '${confirmPhrase}'.`);
      expect(countOccurrences(workflow, confirmPhrase)).toBe(3);
    }
  });
});
