import { describe, expect, it } from "vitest";

import type {
  CatalogIntegrationUnitDescriptor,
  ProviderAdapter,
  ProviderImportPlan,
  ProviderPayloadEnvelope,
} from "./provider-adapter";
import { ProviderAdapterRegistry } from "./registry";

type ReferenceCardPayload = Readonly<{
  providerCardId: string;
  name: string;
}>;

const referencePokemonUnit: CatalogIntegrationUnitDescriptor = {
  unitKey: "reference-cards:pokemon:single-card:source-observation-proof",
  providerKey: "reference-cards",
  productDomain: "pokemon",
  productForm: "single-card",
  ingestionPurpose: "source-observation-proof",
  displayName: "Reference Pokemon single-card Source Observation proof",
};

const referenceMtgUnit: CatalogIntegrationUnitDescriptor = {
  unitKey: "reference-cards:mtg:single-card:source-observation-proof",
  providerKey: "reference-cards",
  productDomain: "mtg",
  productForm: "single-card",
  ingestionPurpose: "source-observation-proof",
  displayName: "Reference MTG single-card Source Observation proof",
};

describe("ProviderAdapterRegistry", () => {
  it("resolves provider adapters by provider key without switch branches", () => {
    const registry = new ProviderAdapterRegistry([referenceCardsAdapter()]);

    expect(registry.require("REFERENCE-CARDS").providerKey).toBe("reference-cards");
    expect(registry.listProviderKeys()).toEqual(["reference-cards"]);
  });

  it("rejects duplicate provider adapter registrations", () => {
    expect(() => new ProviderAdapterRegistry([referenceCardsAdapter(), referenceCardsAdapter()])).toThrow(
      "Duplicate provider adapter registered for 'reference-cards'.",
    );
  });

  it("supports one adapter serving multiple ingestion units with typed payload provenance", async () => {
    const adapter = referenceCardsAdapter();
    const units = await adapter.listIntegrationUnits();
    const plan = await adapter.planImport({
      unitKey: referencePokemonUnit.unitKey,
      scopeKey: "fixture-card",
      values: { fixture: "abra-43" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(units.map((unit) => unit.unitKey)).toEqual([referencePokemonUnit.unitKey, referenceMtgUnit.unitKey]);
    expect(plan.transportSteps).toEqual(["load-fixture-payload"]);
    expect(payloads).toEqual([
      {
        unitKey: referencePokemonUnit.unitKey,
        providerKey: "reference-cards",
        externalKey: "abra-43",
        payload: {
          providerCardId: "abra-43",
          name: "Abra 43/102",
        },
        provenance: {
          fetchedAt: "2026-06-05T00:00:00.000Z",
          sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
          contentHash: "reference-hash-abra-43",
        },
      },
    ]);
  });

  it("keeps transport diagnostics separate from Catalog promotion and replay semantics", async () => {
    const diagnostics = await referenceCardsAdapter().getTransportDiagnostics();

    expect(diagnostics).toEqual([
      {
        code: "reference-fixtures-ready",
        severity: "info",
        message: "Reference fixture payloads are available.",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/promotion|replay|duplicate-prevention/i);
  });
});

function referenceCardsAdapter(): ProviderAdapter<ReferenceCardPayload> {
  return {
    providerKey: "reference-cards",
    capabilities: {
      supportsOptionQueries: true,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    async listIntegrationUnits() {
      return [referencePokemonUnit, referenceMtgUnit];
    },
    async listOptions(input) {
      if (input.unitKey !== referencePokemonUnit.unitKey || input.optionKind !== "fixture-card") {
        return { items: [] };
      }

      return {
        items: [{ value: "abra-43", label: "Abra 43/102" }],
      };
    },
    async planImport(scope) {
      return {
        unitKey: scope.unitKey,
        planKey: `${scope.unitKey}:${scope.scopeKey}`,
        scope,
        estimatedPayloads: 1,
        transportSteps: ["load-fixture-payload"],
      };
    },
    async *fetchPayloads(plan: ProviderImportPlan): AsyncIterable<ProviderPayloadEnvelope<ReferenceCardPayload>> {
      yield {
        unitKey: plan.unitKey,
        providerKey: "reference-cards",
        externalKey: "abra-43",
        payload: {
          providerCardId: "abra-43",
          name: "Abra 43/102",
        },
        provenance: {
          fetchedAt: "2026-06-05T00:00:00.000Z",
          sourceUrl: "fixture://reference-cards/pokemon/abra-43.json",
          contentHash: "reference-hash-abra-43",
        },
      };
    },
    async getTransportDiagnostics() {
      return [
        {
          code: "reference-fixtures-ready",
          severity: "info",
          message: "Reference fixture payloads are available.",
        },
      ];
    },
  };
}

async function collectPayloads<TPayload>(
  payloads: AsyncIterable<ProviderPayloadEnvelope<TPayload>>,
): Promise<ProviderPayloadEnvelope<TPayload>[]> {
  const collected: ProviderPayloadEnvelope<TPayload>[] = [];

  for await (const payload of payloads) {
    collected.push(payload);
  }

  return collected;
}
