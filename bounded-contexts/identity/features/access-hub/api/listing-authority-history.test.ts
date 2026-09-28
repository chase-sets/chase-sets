import { describe, it } from "vitest";
import {
  listingAuthorityHistoryConformance,
  type ListingAuthorityHistoryFixture,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { identityFixture } from "./listing-authority-test-support";
import { IdentityAuthorityMutationPendingError } from "./listing-authority";

async function fixture(): Promise<ListingAuthorityHistoryFixture> {
  const f = await identityFixture();
  let pending: string | undefined;
  let completed = false;
  const invalidate = async () => {
    if (completed) return;
    try {
      if (pending) await f.authority.resumeMutation(pending, f.audit);
      else await f.invalidate();
      completed = true;
    } catch (error) {
      if (error instanceof IdentityAuthorityMutationPendingError) pending = error.mutationId;
      throw error;
    }
  };
  const current = (): ListingAuthorityHistoryFixture => ({
    ...f,
    source: f.authority.source,
    sourceHistories: f.memory.streams,
    consumerHistories: f.consumerMemory.streams,
    sourceEffectStream: `identity.membership-${f.membershipId}`,
    invalidate,
    blockInvalidation: f.blockInvalidation,
    restart: () => {
      f.restart();
      return current();
    },
  });
  return current();
}
describe("actual Identity retained setup and invalidating history", () => {
  listingAuthorityHistoryConformance(it, fixture);
});
