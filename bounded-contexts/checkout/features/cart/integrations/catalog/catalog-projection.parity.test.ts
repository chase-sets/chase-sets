import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { replayCatalogMirror } from "@chase-sets/event-core-postgres/catalog-mirror-replay";
import { buildCheckoutCatalogProjectionHandlers } from "./catalog-projection";

/**
 * Golden parity replay for the checkout catalog mirror.
 *
 * The committed golden file is a recording of the pre-migration handlers (the
 * hand-rolled projection this slice carried before adopting the shared catalog-mirror
 * factory). Every recorded catalog fixture event is replayed through the current
 * handlers. The final mirror state must remain identical to the legacy projection,
 * while emitted effects (normalized SQL + params, reads and writes) must match the
 * deliberately reviewed recording. If the SQL shape changes intentionally, re-record the golden by writing
 * `JSON.stringify(result, null, 2)` to the golden file and review the diff.
 */
describe("checkout catalog projection parity", () => {
  it("replays the recorded catalog fixture with approved effects and legacy-equivalent data", async () => {
    const golden = JSON.parse(
      readFileSync(new URL("./catalog-projection.parity.golden.json", import.meta.url), "utf8"),
    ) as unknown;
    const result = await replayCatalogMirror({
      tablePrefix: "checkout_catalog",
      buildHandlers: buildCheckoutCatalogProjectionHandlers,
    });

    const recordedResult = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(recordedResult.finalState).toEqual((golden as typeof result).finalState);
    expect(recordedResult).toEqual(golden);
  });
});
