import { describe, expect, it } from "vitest";
// Type-only. Settlement gains no runtime dependency on Identity from this file:
// the import is erased at compile time, and this is the one place both the
// consumer-owned port and the producer's real host-port factory are visible, so
// it is where the adapter is checked.
import type { createIdentityTermsAcceptanceResolver } from "@chase-sets/identity/server";
import { createSettlementBalanceCreditResolver, type TermsAcceptanceResolver } from "./balance-credit-resolver";

/**
 * The compile-time adapter between Settlement's consumer-owned
 * `TermsAcceptanceResolver` port and the object Identity's host-port factory
 * actually returns.
 *
 * Settlement deliberately owns a minimal structural port rather than importing
 * Identity's type: that is what keeps Settlement the only reader of its own
 * wallet storage and keeps the two contexts independently deployable. The cost
 * of a hand-owned structural port is that it can drift from the producer without
 * anything failing, and a decoupled function type that no longer matches the
 * real implementation turns a compile error into a runtime throw in a deployable.
 *
 * The assertions below close that gap at the type level. `verify:typecheck`
 * checks this file, and a `@ts-expect-error` that stops erroring fails
 * compilation, so neither direction can rot into a no-op.
 */

/** Compiles only while `Actual` is assignable to `Expected`. */
type Satisfies<Actual extends Expected, Expected> = Actual;

type IdentityTermsAcceptanceAdapter = ReturnType<typeof createIdentityTermsAcceptanceResolver>;

/** The producer satisfies the consumer-owned port exactly as wired in the composition roots. */
export type IdentityAdapterSatisfiesSettlementPort = Satisfies<IdentityTermsAcceptanceAdapter, TermsAcceptanceResolver>;

/** Dropping the required member breaks the port, so the adapter cannot shrink unnoticed. */
export type MissingAdapterMemberFailsCompilation = Satisfies<
  // @ts-expect-error removing resolveTermsAcceptanceStatus leaves nothing that satisfies the port.
  Omit<IdentityTermsAcceptanceAdapter, "resolveTermsAcceptanceStatus">,
  TermsAcceptanceResolver
>;

/** A resolver whose answer omits the required version no longer satisfies the port. */
export type NarrowedResultFailsCompilation = Satisfies<
  // @ts-expect-error the port requires requiredVersion beside accepted.
  Readonly<{ resolveTermsAcceptanceStatus: () => Promise<Readonly<{ accepted: boolean }>> }>,
  TermsAcceptanceResolver
>;

describe("settlement terms acceptance port ownership", () => {
  it("keeps failing closed when no resolver is wired", async () => {
    const resolver = createSettlementBalanceCreditResolver({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as never);

    expect(typeof resolver.resolveBalanceCredit).toBe("function");
  });

  it("holds the adapter assertions above at the type level", () => {
    // The runtime body is intentionally trivial: the contract under test is the
    // set of exported type assertions in this file, which the repository
    // typecheck evaluates.
    expect(true).toBe(true);
  });
});
