import { describe, expect, it } from "vitest";
import {
  createMarketplaceSlug,
  createSlugBase,
  rememberSlugRedirect,
} from "../support/runtime-support/slugs";

describe("marketplace slugs", () => {
  it("normalizes readable words for URL paths", () => {
    expect(createSlugBase("Poke\u0301mon TCG & Sealed: Base Set #4/102")).toBe(
      "pokemon-tcg-and-sealed-base-set-4-102",
    );
  });

  it("adds a stable id suffix so names can collide safely", () => {
    expect(createMarketplaceSlug(["Charizard", "Base Set"], "cat_charizard")).toBe(
      "charizard-base-set-cat-charizard-150bass",
    );
  });

  it("keeps seed ids with the same readable tail from colliding", () => {
    const cardVaultSlug = createMarketplaceSlug(
      ["Twilight Masquerade Elite Trainer Box", "Sealed elite trainer box"],
      "lst_seed_card_vault_twilight_masquerade_etb",
    );
    const sealedStockroomSlug = createMarketplaceSlug(
      ["Twilight Masquerade Elite Trainer Box", "Sealed elite trainer box"],
      "lst_seed_sealed_seller_twilight_masquerade_etb",
    );

    expect(cardVaultSlug).toBe(
      "twilight-masquerade-elite-trainer-box-sealed-elite-trainer-box-twilight-masquerade-etb-n6ilp2",
    );
    expect(sealedStockroomSlug).toBe(
      "twilight-masquerade-elite-trainer-box-sealed-elite-trainer-box-twilight-masquerade-etb-y747ur",
    );
  });

  it("records previous slugs as redirects to the current slug", async () => {
    const calls: unknown[][] = [];
    const db = {
      query: async (_sql: string, values: unknown[]) => {
        calls.push(values);
        return { rows: [] };
      },
    };

    await rememberSlugRedirect(db as never, {
      entityKind: "item",
      entityId: "cat_charizard",
      previousSlug: "charizard-base-set-charizard",
      nextSlug: "charizard-ex-base-set-charizard",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });

    expect(calls).toEqual([
      [
        "item",
        "charizard-base-set-charizard",
        "cat_charizard",
        "charizard-ex-base-set-charizard",
        "2026-05-01T00:00:00.000Z",
      ],
    ]);
  });
});
