import { describe, expect, it } from "vitest";

import {
  createYgoprodeckValidationProviderAdapter,
  runYgoprodeckCardReferenceValidationDryRun,
  runYgoprodeckSetReferenceValidationDryRun,
  YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./ygoprodeck";
import type { ProviderPayloadEnvelope } from "./provider-adapter";

describe("YGOPRODeck provider adapter", () => {
  it("serves Yu-Gi-Oh set and card option queries through the provider adapter boundary", async () => {
    const adapter = createYgoprodeckValidationProviderAdapter();
    const units = await adapter.listIntegrationUnits();
    const sets = await adapter.listOptions({
      unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "sets",
    });
    const cards = await adapter.listOptions({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      optionKind: "cards",
      parentValues: { setName: "Starter Deck: Yugi" },
    });

    expect(units.map((unit) => unit.unitKey)).toEqual([
      YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    ]);
    expect(sets.items).toEqual([
      {
        value: "Starter Deck: Yugi",
        label: "Starter Deck: Yugi",
        metadata: {
          setName: "Starter Deck: Yugi",
          setCode: "SDY",
          cardCount: "50",
          releaseDate: "2002-03-29",
        },
      },
    ]);
    expect(cards.items).toEqual([
      {
        value: "46986414:SDY-006",
        label: "Dark Magician #SDY-006",
        parentValue: "Starter Deck: Yugi",
        metadata: expect.objectContaining({
          cardId: "46986414",
          setName: "Starter Deck: Yugi",
          setCode: "SDY-006",
          rarity: "Ultra Rare",
          cardType: "Normal Monster",
          imageEvidenceAvailable: "true",
        }),
      },
    ]);
  });

  it("plans and fetches card payload envelopes with provenance while excluding price fields", async () => {
    const adapter = createYgoprodeckValidationProviderAdapter();
    const progress: unknown[] = [];
    const plan = await adapter.planImport({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "single-card",
      values: { cardId: "46986414", printCode: "SDY-006" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      planKey: "ygoprodeck:card:46986414:sdy-006",
      estimatedPayloads: 1,
      transportSteps: ["Fetch YGOPRODeck card information", "Select card print payload", "Attach card provenance"],
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygoprodeck",
        externalKey: "card:46986414:SDY-006",
        provenance: expect.objectContaining({
          fetchedAt: "2026-06-21T00:00:00.000Z",
          sourceUrl: "https://db.ygoprodeck.com/api/v7/cardinfo.php?id=46986414",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
        payload: expect.objectContaining({
          kind: "single-card",
          selectedPrint: expect.objectContaining({ set_code: "SDY-006" }),
        }),
      }),
    ]);
    expect(JSON.stringify(payloads)).not.toMatch(/card_prices|set_price|tcgplayer_price|cardmarket_price/i);
    expect(JSON.stringify(payloads[0]?.payload)).toMatch(/card_images/);
    expect(progress).toEqual([{ phase: "fetching", completed: 1, total: 1, currentLabel: "Dark Magician" }]);
  });

  it("plans a guided set-code selection as a set-scoped card import", async () => {
    const adapter = createYgoprodeckValidationProviderAdapter();
    const plan = await adapter.planImport({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { setCode: "RA01" },
    });

    expect(plan).toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      planKey: "ygoprodeck:cards:set:ra01",
      scope: {
        scopeKey: "set",
        values: { setCode: "RA01", setIdentity: "RA01" },
      },
      transportSteps: ["Fetch YGOPRODeck cards by card set", "Select card print payloads", "Attach card provenance"],
    });
  });

  it("plans and fetches set reference envelopes from the shared set list endpoint", async () => {
    const adapter = createYgoprodeckValidationProviderAdapter();
    const plan = await adapter.planImport({
      unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set",
      values: { setName: "Starter Deck: Yugi" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(plan).toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "ygoprodeck:set:starter-deck-yugi",
      estimatedPayloads: 1,
      transportSteps: ["Fetch YGOPRODeck card set list", "Select set reference", "Attach set provenance"],
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "ygoprodeck",
        externalKey: "set:SDY",
        provenance: expect.objectContaining({
          sourceUrl: "https://db.ygoprodeck.com/api/v7/cardsets.php",
          sourceUpdatedAt: "2002-03-29",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
        payload: {
          kind: "set-reference",
          set: {
            set_name: "Starter Deck: Yugi",
            set_code: "SDY",
            num_of_cards: 50,
            tcg_date: "2002-03-29",
          },
          sourceUrl: "https://db.ygoprodeck.com/api/v7/cardsets.php",
        },
      }),
    ]);
  });

  it("proves card and set reference dry-runs without price facts or hotlinked promoted imagery", async () => {
    const card = await runYgoprodeckCardReferenceValidationDryRun();
    const set = await runYgoprodeckSetReferenceValidationDryRun();

    expect(card).toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "ygoprodeck-validation-2026.06.21",
      observations: [
        {
          providerKey: "ygoprodeck",
          externalKey: "card:46986414:SDY-006",
          normalizedFacts: {
            name: "Dark Magician",
            passcode: "46986414",
            setName: "Starter Deck: Yugi",
            setCode: "SDY-006",
            rarity: "Ultra Rare",
            cardType: "Normal Monster",
            frameType: "normal",
            race: "Spellcaster",
            attribute: "DARK",
            imageEvidenceCount: "1",
          },
        },
      ],
      diagnostics: [],
    });
    expect(set).toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      profileVersion: "ygoprodeck-validation-2026.06.21",
      observations: [
        {
          providerKey: "ygoprodeck",
          externalKey: "set:SDY",
          normalizedFacts: {
            name: "Starter Deck: Yugi",
            setCode: "SDY",
            releaseDate: "2002-03-29",
            cardCount: "50",
            productLineName: "Yu-Gi-Oh!",
          },
        },
      ],
      diagnostics: [],
    });
    expect(JSON.stringify([...card.observations, ...set.observations])).not.toMatch(
      /price|image_url|images\.ygoprodeck\.com/i,
    );
  });

  it("keeps credentials not-required and diagnostics focused on transport governance", async () => {
    const adapter = createYgoprodeckValidationProviderAdapter();

    await expect(adapter.getCredentialReadiness()).resolves.toEqual([
      expect.objectContaining({
        providerKey: "ygoprodeck",
        unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
        requirement: "not-required",
        sourceKind: "none",
        importBlocking: false,
      }),
      expect.objectContaining({
        providerKey: "ygoprodeck",
        unitKey: YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
        requirement: "not-required",
        sourceKind: "none",
        importBlocking: false,
      }),
    ]);
    await expect(adapter.getTransportDiagnostics()).resolves.toEqual([
      expect.objectContaining({
        code: "ygoprodeck-public-api-transport-configured",
        severity: "info",
        retryAfterSeconds: 1,
      }),
      expect.objectContaining({
        code: "ygoprodeck-public-api-transport-configured",
        severity: "info",
        retryAfterSeconds: 1,
      }),
    ]);
  });
});

async function collectPayloads<TPayload>(
  payloads: AsyncIterable<ProviderPayloadEnvelope<TPayload>>,
): Promise<ProviderPayloadEnvelope<TPayload>[]> {
  const collected: ProviderPayloadEnvelope<TPayload>[] = [];

  for await (const payload of payloads) {
    collected.push(payload);
  }

  return collected;
}
