import type { ProviderCredentialReadinessState } from "@chase-sets/provider-credentials";

export type ProviderConnectionRow = Readonly<{
  id: string;
  provider: string;
  capability: "catalog-integration" | "channel-connection";
  owner: "catalog" | "channels";
  accountId: string | null;
  status?: string;
  credentialReadiness: ProviderCredentialReadinessState;
  health: string;
  observedAt: string | null;
  freshness: Readonly<{
    freshWithinSeconds: number;
    staleAfterSeconds: number;
    unavailableAfterSeconds: number;
  }> | null;
  destination: Readonly<{ routeId: string; href: string }> | null;
}>;

export type ProviderConnectionsReadSource = () => Promise<
  Readonly<{
    rows: readonly ProviderConnectionRow[];
    complete: boolean;
  }>
>;

export type ProviderConnectionsCrossContextPort = Readonly<{
  catalog?: ProviderConnectionsReadSource;
  channels?: ProviderConnectionsReadSource;
}>;

export type ProviderConnectionsSection = Readonly<{
  state: "available" | "partial" | "unavailable";
  rows: readonly ProviderConnectionRow[];
}>;

export type ProviderConnectionsSnapshot = Readonly<{
  evaluatedAt: string;
  catalog: ProviderConnectionsSection;
  channels: ProviderConnectionsSection;
}>;
