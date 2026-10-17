import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../../source-observations/api/providers/tcgplayer/adapter";
import { resolveHeldSetExport } from "./held-set-resolution";

describe("held-set resolver", () => {
  it("keeps a shared set label isolated by TCGplayer unit", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("catalog_provider_scope_observations")) {
        return {
          rows: [
            {
              unit_key: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
              scope_kind: "set",
              language_code: "en",
              external_id: "magic-shared",
              label: "Shared Name",
            },
            {
              unit_key: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
              scope_kind: "expansion",
              language_code: "en",
              external_id: "pokemon-shared",
              label: " shared   name ",
            },
          ],
        };
      }
      return {
        rows: [
          {
            unit_key: TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
            set_id: "magic-shared",
            scope_record_id: "scope-magic",
            review_status: "accepted",
            product_domain: "magic",
            scope_kind: "set",
          },
          {
            unit_key: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
            set_id: "pokemon-shared",
            scope_record_id: "scope-pokemon",
            review_status: "auto-accepted",
            product_domain: "pokemon",
            scope_kind: "expansion",
          },
        ],
      };
    });
    const db = { query } as unknown as PgQueryable;

    const result = await resolveHeldSetExport(
      db,
      new TextEncoder().encode(
        "Product Line,Set Name\nMagic,Shared Name\nPokemon,Shared Name\nPokemon Japan,Shared Name",
      ),
    );

    expect(result.resolved.map((row) => row.scopeRecordId)).toEqual(["scope-magic", "scope-pokemon"]);
    expect(result.unresolved).toEqual([
      expect.objectContaining({ productLine: "Pokemon Japan", reason: "product-line-unresolved" }),
    ]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
