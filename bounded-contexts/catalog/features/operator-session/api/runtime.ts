import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SecretEnvelopeKeyring } from "@chase-sets/platform-runtime/secret-envelope";
import {
  createTcgplayerAutomationCatalogClient,
  type TcgplayerAutomationCatalogClient,
} from "../../source-observations/api/providers/tcgplayer-automation-catalog-client";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
  TcgplayerAutomationCredentialUnavailableError,
  type TcgplayerAutomationAuthConfig,
  type TcgplayerAutomationHttpClientDeps,
  type TcgplayerAutomationHttpConfigInput,
} from "../../source-observations/api/providers/tcgplayer-automation-client";
import { validateOperatorSessionValue } from "../domain/value";
import { createPostgresCatalogOperatorSessionStore } from "./store";

export type OperatorSessionCatalogClient = TcgplayerAutomationCatalogClient &
  Readonly<{
    resolveCredentialReadiness(): Promise<{
      sourceKind: "operator-session" | "environment-secret";
      state: "configured" | "missing";
    }>;
  }>;

export function createTcgplayerAutomationRuntime(
  input: {
    pool: PgQueryable;
    config: TcgplayerAutomationHttpConfigInput | null;
    keyring: SecretEnvelopeKeyring | null;
  },
  deps: TcgplayerAutomationHttpClientDeps = {},
) {
  const environmentValue = input.config?.auth?.tcgAuthCookie ?? null;
  if (!input.keyring && !environmentValue) return undefined;
  const store = createPostgresCatalogOperatorSessionStore(input.pool, input.keyring);
  async function resolveCredential(): Promise<{
    sourceKind: "operator-session" | "environment-secret";
    auth: Pick<TcgplayerAutomationAuthConfig, "tcgAuthCookie" | "credential"> | null;
  }> {
    const resolution = await store.resolve();
    const sourceKind = resolution ? "operator-session" : "environment-secret";
    if (resolution && "unavailable" in resolution) return { sourceKind, auth: null };
    const value = resolution?.value ?? environmentValue;
    if (!value) return { sourceKind, auth: null };
    try {
      validateOperatorSessionValue(value);
    } catch {
      return { sourceKind, auth: null };
    }
    return {
      sourceKind,
      auth: {
        tcgAuthCookie: value,
        credential: resolution
          ? { source: "operator-session", revision: resolution.revision }
          : { source: "environment", revision: 0 },
      },
    };
  }
  const configStore = createPostgresTcgplayerAutomationHttpConfigStore(input.pool, input.config ?? {}, async () => {
    const { auth } = await resolveCredential();
    if (!auth) throw new TcgplayerAutomationCredentialUnavailableError();
    return auth;
  });
  const httpClients = createTcgplayerAutomationHttpClients(configStore, deps);
  const catalogClient: OperatorSessionCatalogClient = {
    ...createTcgplayerAutomationCatalogClient(httpClients),
    async resolveCredentialReadiness() {
      const { sourceKind, auth } = await resolveCredential();
      return { sourceKind, state: auth ? "configured" : "missing" };
    },
  };
  return { store, configStore, httpClients, catalogClient };
}
