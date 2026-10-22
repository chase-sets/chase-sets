import type { AccountId, SessionId } from "../../primitives/typed-ids";

export type DiscoverySearchSessionStartedPayload = Readonly<{
  accountId: AccountId;
  sessionId: SessionId;
}>;

export type DiscoveryEventPayloads = Readonly<{
  "discovery.search-session.started": DiscoverySearchSessionStartedPayload;
}>;
