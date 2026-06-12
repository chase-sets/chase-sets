import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { replayCatalogMirror } from "@chase-sets/event-core-postgres/catalog-mirror-replay";
import { buildMarketplaceCatalogProjectionHandlers } from "./supply-projection";

/**
 * Golden parity replay for the marketplace catalog mirror.
 *
 * The committed golden file is a recording of the pre-migration handlers (the
 * hand-rolled projection this slice carried before adopting the shared catalog-mirror
 * factory). Every recorded catalog fixture event is replayed through the current
 * handlers, and the emitted effects (normalized SQL + params, reads and writes) plus
 * the final mirror state must deep-equal the legacy recording. If the mirror's
 * behavior ever changes intentionally, re-record the golden by writing
 * `JSON.stringify(result, null, 2)` to the golden file and review the diff.
 */
describe("marketplace catalog projection parity", () => {
  it("replays the recorded catalog fixture with effects identical to the legacy projection", async () => {
    const golden = JSON.parse(
      readFileSync(new URL("./supply-projection.parity.golden.json", import.meta.url), "utf8"),
    ) as unknown;
    const result = await replayCatalogMirror({
      tablePrefix: "marketplace_catalog",
      buildHandlers: buildMarketplaceCatalogProjectionHandlers,
    });

    expect(JSON.parse(JSON.stringify(result))).toEqual(golden);
  });
});
