import { describe, expect, it } from "vitest";
import { parseRepricingDeskPrefill } from "./account-desk-repricing";

describe("repricing desk migration prefill", () => {
  it("builds the track-market editor body for populated and zero offsets", () => {
    expect(
      parseRepricingDeskPrefill("?prefill=market-offset&anchor=market-estimate&offsetPercent=0&currency=usd"),
    ).toMatchObject({
      notice: null,
      body: {
        name: "Track market estimate",
        rules: [
          {
            directive: {
              offset: { mode: "percent", percent: 0 },
              anchorChain: [{ source: "market-estimate" }, { source: "lowest-competing-ask" }, { source: "last-sold" }],
            },
          },
        ],
      },
    });
  });

  it.each([
    "?prefill=market-offset&anchor=wrong&offsetPercent=1&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=nope&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=1",
  ])("opens an unfilled editor for malformed or partial input: %s", (search) => {
    expect(parseRepricingDeskPrefill(search)).toMatchObject({ body: null, notice: expect.any(String) });
  });
});
