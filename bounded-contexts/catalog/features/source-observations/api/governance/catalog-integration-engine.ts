import { parseCatalogIntegrationUnitKey, type CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderPayloadEnvelope } from "../provider-adapters/provider-adapter";

export type CatalogIntegrationEngineDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  diagnosticText: string;
  unitKey: CatalogIntegrationUnitKey;
  externalKey?: string;
  path?: string;
}>;

export type CatalogIntegrationObservationFact = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  providerKey: string;
  externalKey: string;
  profileVersion: string;
  normalizedFacts: Readonly<Record<string, string>>;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  sourceHash?: string;
}>;

export type CatalogIntegrationDryRunInput<TPayload> = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  profileVersion: string;
  payloads: readonly ProviderPayloadEnvelope<TPayload>[];
  normalize(payload: ProviderPayloadEnvelope<TPayload>): CatalogIntegrationObservationFact;
}>;

export type CatalogIntegrationDryRunResult = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  profileVersion: string;
  observations: readonly CatalogIntegrationObservationFact[];
  diagnostics: readonly CatalogIntegrationEngineDiagnostic[];
}>;

export function runCatalogIntegrationDryRun<TPayload>(
  input: CatalogIntegrationDryRunInput<TPayload>,
): CatalogIntegrationDryRunResult {
  const identity = parseCatalogIntegrationUnitKey(input.unitKey);
  const diagnostics: CatalogIntegrationEngineDiagnostic[] = [];
  const observations: CatalogIntegrationObservationFact[] = [];

  for (const payload of input.payloads) {
    if (payload.unitKey !== input.unitKey) {
      diagnostics.push({
        code: "integration-unit-mismatch",
        severity: "error",
        diagnosticText: "Provider payload was produced for a different Catalog integration unit.",
        unitKey: input.unitKey,
        externalKey: payload.externalKey,
        path: "payload.unitKey",
      });
      continue;
    }

    if (payload.providerKey !== identity.providerKey) {
      diagnostics.push({
        code: "provider-key-mismatch",
        severity: "error",
        diagnosticText: "Provider payload key does not match the Catalog integration unit provider key.",
        unitKey: input.unitKey,
        externalKey: payload.externalKey,
        path: "payload.providerKey",
      });
      continue;
    }

    const observation = input.normalize(payload);

    if (
      observation.unitKey !== input.unitKey ||
      observation.providerKey !== payload.providerKey ||
      observation.externalKey !== payload.externalKey ||
      observation.profileVersion !== input.profileVersion
    ) {
      diagnostics.push({
        code: "normalized-observation-identity-mismatch",
        severity: "error",
        diagnosticText: "Normalized Source Observation fact does not preserve engine input identity.",
        unitKey: input.unitKey,
        externalKey: payload.externalKey,
        path: "normalize",
      });
      continue;
    }

    observations.push(observation);
  }

  if (observations.length === 0 && diagnostics.length === 0) {
    diagnostics.push({
      code: "no-provider-payloads",
      severity: "warning",
      diagnosticText: "Dry run did not receive provider payloads to evaluate.",
      unitKey: input.unitKey,
    });
  }

  return {
    unitKey: input.unitKey,
    profileVersion: input.profileVersion,
    observations,
    diagnostics,
  };
}
