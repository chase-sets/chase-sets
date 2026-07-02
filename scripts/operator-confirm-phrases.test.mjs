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

  it("keeps staging reset workflow prompt and guard on the same confirm phrase", () => {
    const workflow = readRepoFile(".github/workflows/platform-staging-reset.yml");
    const descriptionMatch = workflow.match(/description: Type "([^"]+)" to destroy and recreate staging/);

    expect(descriptionMatch, "workflow dispatch description must name the reset confirm phrase").not.toBeNull();
    const confirmPhrase = descriptionMatch?.[1] ?? "";

    expect(workflow).toContain(`if [ "\${{ inputs.confirm }}" != "${confirmPhrase}" ]; then`);
    expect(workflow).toContain(`Confirmation input must exactly equal '${confirmPhrase}'.`);
    expect(countOccurrences(workflow, confirmPhrase)).toBe(3);
  });
});
