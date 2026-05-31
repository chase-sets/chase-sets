import { attachResponseMetadata, readApiErrorMessage } from "@chase-sets/http/responses";
import {
  normalizeRolloutEnvironment,
  type ReleaseControlPolicyDecision,
  type RolloutEnvironment,
  type RolloutSubject,
} from "@chase-sets/release-controls";
import {
  buildReleaseControlsSnapshot,
  readReleaseControlsQuery,
  type ReleaseControlsSnapshot,
} from "../read-model/contracts";
import type { ReleaseControlsPolicySnapshot } from "../read-model/policy-contracts";

export type { ReleaseControlPolicyDecision, RolloutEnvironment, RolloutSubject, ReleaseControlsPolicySnapshot };

export { normalizeRolloutEnvironment };

export class PlatformOperationsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `API error ${status}`));
  }
}

export type PlatformOperationsApiClientOptions = Readonly<{
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}>;

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new PlatformOperationsApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function decisionQuery(input: Readonly<{ environment: RolloutEnvironment; subject: RolloutSubject }>) {
  const query = new URLSearchParams();
  query.set("environment", input.environment);
  query.set("subjectType", input.subject.subjectType);
  query.set("subjectId", input.subject.subjectId);
  return query.toString();
}

function jsonHeaders(headers: HeadersInit | undefined): Headers {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json");
  return result;
}

export function createPlatformOperationsApiClient({
  baseUrl = "/api/platform",
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: PlatformOperationsApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const headers = resolveHeaders(initialHeaders);

  return {
    getReleaseControlsPolicy: async () =>
      parseJsonResponse<ReleaseControlsPolicySnapshot>(
        await configuredFetch(`${baseUrl}/release-controls`, { headers }),
      ),
    setReleaseLock: async (body: Readonly<{ locked: boolean; reason?: string; reference?: string }>) =>
      parseJsonResponse<ReleaseControlsPolicySnapshot>(
        await configuredFetch(`${baseUrl}/release-controls/release-lock`, {
          method: "POST",
          headers: jsonHeaders(headers),
          body: JSON.stringify(body),
        }),
      ),
    setRolloutPolicy: async (
      featureKey: string,
      body: Readonly<{
        environment: RolloutEnvironment;
        percentage: number;
        allowSubjects?: readonly string[] | string;
        optOutSubjects?: readonly string[] | string;
        killSwitchActive?: boolean;
        reason: string;
        reference: string;
      }>,
    ) =>
      parseJsonResponse<ReleaseControlsPolicySnapshot>(
        await configuredFetch(`${baseUrl}/release-controls/rollouts/${encodeURIComponent(featureKey)}`, {
          method: "PUT",
          headers: jsonHeaders(headers),
          body: JSON.stringify(body),
        }),
      ),
    evaluateRollout: async (
      featureKey: string,
      input: Readonly<{ environment: RolloutEnvironment; subject: RolloutSubject }>,
    ) =>
      parseJsonResponse<ReleaseControlPolicyDecision>(
        await configuredFetch(
          `${baseUrl}/release-controls/rollouts/${encodeURIComponent(featureKey)}/decision?${decisionQuery(input)}`,
          { headers },
        ),
      ),
  };
}

export function loadReleaseControlsSnapshot(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseControlsSnapshot {
  return buildReleaseControlsSnapshot(readReleaseControlsQuery(request), env);
}

export const platformOperationsApi = createPlatformOperationsApiClient();
