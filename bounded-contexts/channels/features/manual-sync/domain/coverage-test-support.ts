import type { ConnectorAuthority } from "../../connector-feed/domain/contracts";

export function liveAuthority(): ConnectorAuthority {
  return {
    accountId: "account-owner",
    connectionId: "connection-tcg",
    connectionState: "active",
    inbound: "live",
    pairingId: "pair-synthetic",
    claimReportAllowed: false,
    grant: {
      grantId: "grant-synthetic",
      accountId: "account-owner",
      connectionId: "connection-tcg",
      pairingId: "pair-synthetic",
      userId: "removed-grantor",
      clientId: "client-synthetic",
      revision: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      valid: true,
    },
  };
}
