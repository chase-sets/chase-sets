import { describe, it } from "vitest";
import {
  listingAuthorityHistoryConformance,
  type ListingAuthorityHistoryFixture,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { authFixture } from "./listing-authority-test-support";
import { AuthSessionMutationPendingError } from "./listing-authority";

async function historyFixture(): Promise<ListingAuthorityHistoryFixture> {
  const f = await authFixture({ sourceOnly: true });
  let pendingMutationId: string | undefined;
  let completed = false;
  async function invalidate() {
    if (completed) return;
    try {
      if (pendingMutationId) await f.sessions.listingAuthority.resumeMutation(pendingMutationId, f.audit);
      else await f.invalidate();
      completed = true;
    } catch (error) {
      if (error instanceof AuthSessionMutationPendingError) pendingMutationId = error.mutationId;
      throw error;
    }
  }
  function current(): ListingAuthorityHistoryFixture {
    return {
      ...f,
      source: f.sessions.listingAuthority.source,
      sourceHistories: f.authMemory.streams,
      consumerHistories: f.consumerMemory.streams,
      sourceEffectStream: f.streamId,
      invalidate,
      blockInvalidation: f.setUnknownAbort,
      restart: () => {
        f.restart();
        return current();
      },
    };
  }
  return current();
}

describe("actual Auth retained histories with a distinct consumer store", () => {
  listingAuthorityHistoryConformance(it, historyFixture);
});
