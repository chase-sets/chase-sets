import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EvidenceWindowProviderWrite } from "@chase-sets/evidence-window-provider-write";
import type {
  createEvidenceWindowDisposition,
  EvidenceWindowDispositionReceiptPolicy,
} from "../../bounded-contexts/payments/features/payments/api/evidence-window-disposition";

export function createTestWindowDriver(
  manifest: unknown,
  options: {
    pool: PgTransactionalPool;
    secretKey: string;
    fixtures: Readonly<Record<string, unknown>>;
    browser: { close(): Promise<void> };
    send?: typeof globalThis.fetch;
    authoritySignal?: AbortSignal;
  },
): {
  journal: EvidenceWindowProviderWrite;
  groups: Array<{
    flow: string;
    windowId: string;
    open(): Promise<void>;
    close(): Promise<void>;
    dispose(
      policy: EvidenceWindowDispositionReceiptPolicy,
    ): ReturnType<ReturnType<typeof createEvidenceWindowDisposition>>;
    scenarios: Array<{
      mapper: string;
      activate(phase: string): Promise<void>;
      original(): Promise<unknown>;
      restartAndReplay(): Promise<unknown>;
      repeatSameSlot(): Promise<unknown>;
      reuse(): Promise<void>;
    }>;
  }>;
  dispose(): Promise<void>;
  creationCount(): number;
  counts(): { scenario: number; browser: number; disposition: number; total: number };
  sends(): Array<Record<string, unknown>>;
  lifecycle(): Array<Record<string, unknown>>;
};
