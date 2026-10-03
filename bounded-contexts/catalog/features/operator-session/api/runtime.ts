import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { SecretEnvelopeKeyring } from "@chase-sets/platform-runtime/secret-envelope";
import {
  createTcgplayerAutomationCatalogClient,
  type TcgplayerAutomationCatalogClient,
} from "../../source-observations/api/providers/tcgplayer-automation-catalog-client";
import {
  createPostgresTcgplayerAutomationHttpConfigStore,
  createTcgplayerAutomationHttpClients,
  TcgplayerAutomationCredentialUnavailableError,
  type TcgplayerAutomationHttpClientDeps,
  type TcgplayerAutomationHttpConfigInput,
} from "../../source-observations/api/providers/tcgplayer-automation-client";
import { deriveTcgplayerOperatorSessionReadiness } from "../domain/readiness";
import { createOperatorSessionOutcomeRecorder } from "./outcomes";
import { createPostgresCatalogOperatorSessionStore, readCatalogOperatorSessionSnapshot } from "./store";

export type OperatorSessionCatalogClient = TcgplayerAutomationCatalogClient &
  Readonly<{
    transportConfigured: boolean;
    resolveCredentialReadiness(): Promise<ReturnType<typeof deriveTcgplayerOperatorSessionReadiness>>;
  }>;

export function createTcgplayerAutomationRuntime(
  input: {
    pool: PgTransactionalPool;
    config: TcgplayerAutomationHttpConfigInput | null;
    keyring: SecretEnvelopeKeyring | null;
  },
  deps: TcgplayerAutomationHttpClientDeps = {},
) {
  const environmentValue = input.config?.auth?.tcgAuthCookie ?? null;
  const store = createPostgresCatalogOperatorSessionStore(input.pool, input.keyring);
  const snapshot = () => readCatalogOperatorSessionSnapshot(input.pool, input.keyring, environmentValue);
  const configStore = createPostgresTcgplayerAutomationHttpConfigStore(input.pool, input.config ?? {}, async () => {
    const { value, readiness } = await snapshot();
    if (!value || !readiness.identity) throw new TcgplayerAutomationCredentialUnavailableError();
    const { source, revision, custodyRevision } = readiness.identity;
    return { tcgAuthCookie: value, credential: { source, revision }, custodyRevision };
  });
  const observedConfigStore = {
    ...configStore,
    recordCredentialOutcome: createOperatorSessionOutcomeRecorder(input.pool),
  };
  const httpClients = createTcgplayerAutomationHttpClients(observedConfigStore, deps);
  const catalogClient: OperatorSessionCatalogClient = {
    ...createTcgplayerAutomationCatalogClient(httpClients),
    transportConfigured: Boolean(input.keyring || environmentValue),
    async resolveCredentialReadiness() {
      return deriveTcgplayerOperatorSessionReadiness((await snapshot()).readiness, (deps.now ?? Date.now)());
    },
  };
  return { store, configStore: observedConfigStore, httpClients, catalogClient };
}
