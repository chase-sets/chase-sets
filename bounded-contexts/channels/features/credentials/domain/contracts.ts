import type { ChannelEnvironment } from "../../connections/domain/contracts";

export type ChannelOAuthTokenSet = Readonly<{
  format: "ChannelOAuthTokenSet/v1";
  accessToken: string;
  refresh: Readonly<{ kind: "absent" }> | Readonly<{ kind: "present"; token: string; expiresAt: string | null }>;
  accessExpiresAt: string | null;
  issuedAt: string;
}>;

export type ChannelCredentialEnvelope = Readonly<{
  version: "ChannelCredentialEnvelope/v1";
  rowId: string;
  kind: "oauth-token-set";
  providerKey: string;
  environment: ChannelEnvironment;
  accountId: string;
  connectionId: string;
  payloadFormat: "ChannelOAuthTokenSet/v1";
  tokenGeneration: number;
  envelopeRevision: number;
  keyId: string;
  createdAt: string;
  updatedAt: string;
}>;

export type ChannelCredentialKeyring = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
}>;

export class ChannelCredentialError extends Error {
  constructor(
    public readonly code:
      | "invalid-payload"
      | "invalid-envelope"
      | "invalid-keyring"
      | "unavailable"
      | "conflict"
      | "forbidden"
      | "counter-overflow"
      | "storage-unavailable",
  ) {
    super(code);
    this.name = "ChannelCredentialError";
  }
}
