import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AuthListingSessionAuthorityHostPorts } from "./listing-authority";
import type { SessionTokenStore } from "./session-token-store";

export type AuthRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  listingAuthorityConsumer?: AuthListingSessionAuthorityHostPorts["listingAuthorityConsumer"];
  sessionTokens?: SessionTokenStore;
}>;
