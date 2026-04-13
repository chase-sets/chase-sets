import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  AccountId,
  CommandId,
  CorrelationId,
  UserId,
} from "@chase-sets/primitives/typed-ids";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  IDENTITY_BOOTSTRAP_ACCOUNT_ID,
  IDENTITY_BOOTSTRAP_TENANT_ID,
  IDENTITY_BOOTSTRAP_USER_ID,
} from "../../features/memberships/read-model/constants";

export function createIdentityBootstrapContext(): EventStoreContext {
  return {
    tenantId: IDENTITY_BOOTSTRAP_TENANT_ID as never,
    audit: {
      performedByUserId: IDENTITY_BOOTSTRAP_USER_ID as UserId,
      forAccountId: IDENTITY_BOOTSTRAP_ACCOUNT_ID as AccountId,
    },
    trace: {
      correlationId: createId("cor") as CorrelationId,
      commandId: createId("cmd") as CommandId,
    },
  };
}
