// Auth-owned public event payloads.
import type { AccountId, SessionId, UserId } from "../../primitives/typed-ids";
import type { EmptyEventPayload } from "./event-core";

export type AuthSessionStartedPayload = Readonly<{
  sessionId: SessionId;
  userId: UserId;
  accountId: AccountId;
  availableAccountIds: readonly string[];
  authenticationMethod: string;
  expiresAt: string;
}>;

export type AuthSessionAccountSwitchedPayload = Readonly<{
  accountId: AccountId;
}>;

export type AuthEventPayloads = Readonly<{
  "auth.session.started": AuthSessionStartedPayload;
  "auth.session.account-switched": AuthSessionAccountSwitchedPayload;
  "auth.session.revoked": EmptyEventPayload;
  "auth.session.expired": EmptyEventPayload;
}>;
