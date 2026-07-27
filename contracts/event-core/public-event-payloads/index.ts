// Public event payload aggregate.
//
// Every context owns one module in this directory; this file is the only thing that
// composes them. A context publishing a new event edits its own module, so the
// aggregate stops being the file every context PR has to touch. The published deep
// specifier `@chase-sets/event-core/public-event-payloads` resolves here, so the
// import surface is unchanged for every consumer.
//
// Membership is guarded by `../public-event-payloads.test.ts`: a module in this
// directory that is not re-exported below fails the partition test.
import type { AuthEventPayloads } from "./auth";
import type { CheckoutEventPayloads } from "./checkout";
import type { IdentityEventPayloads } from "./identity";
import type { InventoryEventPayloads } from "./inventory";
import type { MarketplaceEventPayloads } from "./marketplace";
import type { OrderingEventPayloads } from "./ordering";
import type { PaymentsEventPayloads } from "./payments";
import type {
  PlatformOperationsEventPayloads,
  SupportRequestPlatformCoverageEventPayloads,
} from "./platform-operations";
import type { PublicPresenceEventPayloads } from "./public-presence";
import type { SettlementEventPayloads } from "./settlement";

export * from "./event-core";
export * from "./auth";
export * from "./identity";
export * from "./inventory";
export * from "./ordering";
export * from "./marketplace";
export * from "./checkout";
export * from "./payments";
export * from "./settlement";
export * from "./platform-operations";
export * from "./public-presence";

export type ChaseSetsEventPayloads = AuthEventPayloads &
  IdentityEventPayloads &
  CheckoutEventPayloads &
  InventoryEventPayloads &
  OrderingEventPayloads &
  MarketplaceEventPayloads &
  PaymentsEventPayloads &
  SettlementEventPayloads &
  SupportRequestPlatformCoverageEventPayloads &
  PublicPresenceEventPayloads &
  PlatformOperationsEventPayloads;
