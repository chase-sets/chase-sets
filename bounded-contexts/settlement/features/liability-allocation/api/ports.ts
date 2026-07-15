import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  ReserveProtectionCoverageInput,
  ReserveProtectionCoverageResult,
  SettleProtectionCoverageInput,
  TerminalProtectionCoverageResult,
} from "../../protection-coverage/api/protection-coverage-runtime";
import type { ProtectionCoverageRow } from "../../protection-coverage/read-model/protection-coverage-queries";

/**
 * The narrow slice of the ProtectionCoverage runtime the liability-allocation
 * integration depends on: reserve the platform-funded portion when Support requests
 * coverage, consume (settle) it exactly once when the correlated refund completes, and
 * read the reservation to guard the consumption. Declaring the dependency as a port
 * keeps the integration testable with a fake and inverts the compile dependency onto
 * the aggregate the issue must consume (never reinvent).
 *
 * The concrete `createProtectionCoverageRuntime` result satisfies this structurally.
 */
export type ProtectionCoverageSettlementPort = Readonly<{
  reserve: (
    input: ReserveProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<ReserveProtectionCoverageResult>;
  settle: (
    input: SettleProtectionCoverageInput,
    context: EventStoreContext,
  ) => Promise<TerminalProtectionCoverageResult>;
  getCoverage: (coverageId: string) => Promise<ProtectionCoverageRow | null>;
}>;
