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
    "?anchor=market-estimate&offsetPercent=1&currency=USD",
    "?prefill=other&anchor=market-estimate&offsetPercent=1&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=1&currency=USD&extra=1",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=1&offsetPercent=2&currency=USD",
    "?prefill=market-offset&anchor=wrong&offsetPercent=1&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=nope&currency=USD",
    "?prefill=market-offset&anchor=market-estimate&offsetPercent=1",
  ])("opens an unfilled editor for malformed or partial input: %s", (search) => {
    expect(parseRepricingDeskPrefill(search)).toMatchObject({
      body: null,
      notice: "The migration suggestion was incomplete. Enter the policy values manually.",
    });
  });
  it("localizes the out-of-range prefill notice and leaves the editor unfilled", () => {
    expect(
      parseRepricingDeskPrefill("?prefill=market-offset&anchor=market-estimate&offsetPercent=1001&currency=USD"),
    ).toEqual({ body: null, notice: "The migration suggestion is outside the supported policy range." });
  });
  it("populates a nonzero offset without filling the required floor", () => {
    expect(
      parseRepricingDeskPrefill(
        "?create=1&prefill=market-offset&anchor=market-estimate&offsetPercent=-2.45&currency=USD",
      ).body?.rules[0]?.directive,
    ).toMatchObject({ offset: { mode: "percent", percent: -2.45 }, floor: { mode: "absolute", amount: "" } });
  });
});
