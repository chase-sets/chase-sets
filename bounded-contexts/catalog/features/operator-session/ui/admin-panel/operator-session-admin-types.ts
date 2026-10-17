// Non-behavioral: the provider the Operator session panel belongs to and the
// closed GET /api/catalog/operator-session metadata shape (api/grants.ts).
// The page and loader gate on the provider key without importing the panel;
// the HTTP operations and their validation live in operator-session-panel.tsx.
export const operatorSessionProviderKey = "tcgplayer";

export type OperatorSessionGrantMetadata = Readonly<{
  active: boolean;
  createdAt: string;
  idleExpiresAt: string;
  lastUsedAt: string;
}>;

export type OperatorSessionMetadata = Readonly<{
  revision: number;
  storedAt: string | null;
  browserExpiresAt: string | null;
  custodyAvailable: boolean;
  grant: OperatorSessionGrantMetadata | null;
}>;
