import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { platformCoverageReconciliationSignals } from "../features/liability-allocation/read-model/reconciliation-signals";
import { coverageRolloutModes } from "../features/protection-coverage/domain/coverage-rollout-policy";

/**
 * Pins the operator acceptance packet to the code that backs it, so the packet and the
 * proof/observability/rollout modules stay co-enforcing: editing one without the other
 * fails here. Reading the doc by filename also gives it its required inbound reference for
 * the bounded-context docs guard.
 */

const packetPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../docs/platform-coverage-reconciliation-acceptance.md",
);
const packet = readFileSync(packetPath, "utf8");

describe("platform-coverage reconciliation acceptance packet", () => {
  it("names every required journey by ID", () => {
    for (let journey = 1; journey <= 13; journey += 1) {
      expect(packet).toContain(`| J${journey} |`);
    }
  });

  it("anchors acceptance to the two automated proofs", () => {
    expect(packet).toContain("platform-coverage-reconciliation-proof.test.ts");
    expect(packet).toContain("platform-coverage-remedy-lifecycle-proof.test.ts");
  });

  it("references every reconciliation signal module and the daily by-currency report", () => {
    expect(packet).toContain("reconciliation-signals.ts");
    expect(packet).toContain("computeDailyReconciliationByCurrency");
    // The packet must describe every listed inconsistency the signal registry covers.
    for (const signal of platformCoverageReconciliationSignals) {
      expect(packet.toLowerCase()).toContain(signal.title.split(" ")[0]!.toLowerCase());
    }
  });

  it("documents the enable / pause / rollback / forward-repair rollout controls", () => {
    for (const action of ["Enable", "Pause", "Rollback", "Forward-repair"]) {
      expect(packet).toContain(`**${action}**`);
    }
    for (const mode of coverageRolloutModes) {
      expect(packet).toContain(mode);
    }
    expect(packet).toContain("coverage-rollout-policy.ts");
  });

  it("records SLOs, escalation owners, and the sign-off gate", () => {
    expect(packet).toContain("## SLOs and escalation ownership");
    expect(packet).toContain("Settlement on-call");
    expect(packet).toContain("Payments on-call");
    expect(packet).toContain("Fulfillment on-call");
    expect(packet).toContain("Support on-call");
    expect(packet).toContain("## Acceptance confirmation");
  });

  it("cross-links the composed terminal evidence rather than duplicating it", () => {
    for (const reference of ["#3733", "#571", "#596", "#5223"]) {
      expect(packet).toContain(reference);
    }
  });

  it("preserves the golden assertion and the no-close-while-pending invariant", () => {
    expect(packet).toContain("refunds the buyer exactly once");
    expect(packet).toContain("cannot close until");
  });
});
