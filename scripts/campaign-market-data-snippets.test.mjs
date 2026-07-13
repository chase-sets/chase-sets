import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildCampaignMarketDataArtifact,
  loadCampaignMarketData,
  parseCampaignMarketDataArgs,
  renderCampaignMarketDataMarkdown,
  validateCampaignMarketDataOptions,
} from "./campaign-market-data-snippets.mjs";

const fixturePath = "scripts/fixtures/campaign-market-data/weekly-product.json";

describe("campaign market-data snippets", () => {
  it("produces deterministic, explicitly non-publishable fixture copy", async () => {
    const source = JSON.parse(await readFile(fixturePath, "utf8"));
    const first = buildCampaignMarketDataArtifact(source, "fixture");
    const second = buildCampaignMarketDataArtifact(source, "fixture");

    expect(second).toEqual(first);
    expect(first.publication.publishable).toBe(false);
    expect(first.snippets.x).toContain("9 completed, non-excluded trades");
    expect(first.snippets.x).toContain("$11.00 (2026-07-13) → $12.50 (2026-07-20)");
    expect(first.snippets.x).toContain("not a game-wide price index or per-grade price guide");
    expect(first.snippets.xThread.every((post) => post.length <= 280)).toBe(true);
    expect(renderCampaignMarketDataMarkdown(first)).toContain("DO NOT PUBLISH — FIXTURE/STAGING REHEARSAL");
  });

  it("suppresses a movement claim when fewer than two medians clear Pricing's gate", async () => {
    const source = JSON.parse(await readFile(fixturePath, "utf8"));
    source.series.items[0].medianPriceAmount = null;
    const artifact = buildCampaignMarketDataArtifact(source, "staging");

    expect(artifact.snippets.x).toContain("No two weekly medians cleared Pricing's minimum-sample display gate");
    expect(artifact.facts.medianMovement).toBeNull();
    expect(artifact.publication.publishable).toBe(false);
  });

  it("refuses to relabel fixture input as production", () => {
    const options = parseCampaignMarketDataArgs([
      "--input",
      fixturePath,
      "--source-environment",
      "production",
      "--out",
      "artifacts/campaigns/example",
    ]);
    expect(validateCampaignMarketDataOptions(options)).toContain(
      "--input is fixture-only and cannot be labeled staging or production.",
    );
  });

  it("refuses to mark staging or arbitrary API data as production", () => {
    const options = parseCampaignMarketDataArgs([
      "--api-base-url",
      "https://marketplace.staging.chasesets.com/api/marketplace",
      "--source-environment",
      "production",
      "--catalog-item-id",
      "cat_1",
      "--product-id",
      "prod_1",
      "--title",
      "Card",
      "--game",
      "Game",
      "--community",
      "r/game",
      "--from",
      "2026-07-20",
      "--to",
      "2026-07-26",
      "--as-of",
      "2026-07-26",
      "--out",
      "artifacts/campaigns/example",
    ]);

    expect(validateCampaignMarketDataOptions(options)).toContain(
      "--source-environment production requires --api-base-url https://marketplace.chasesets.com/api/marketplace.",
    );
  });

  it("rejects a displayed median below the Pricing stat-hygiene threshold", async () => {
    const source = JSON.parse(await readFile(fixturePath, "utf8"));
    source.series.items[0].tradeCount = 2;
    source.series.items[0].verifiedTradeCount = 2;

    expect(() => buildCampaignMarketDataArtifact(source, "fixture")).toThrow(
      "medianPriceAmount must be null below the stat-hygiene minimum sample",
    );
  });

  it("omits spread copy when the market-state read model has no snapshot", async () => {
    const source = JSON.parse(await readFile(fixturePath, "utf8"));
    source.stats.marketState = null;

    const artifact = buildCampaignMarketDataArtifact(source, "fixture");
    expect(artifact.snippets.x).not.toContain("lowest active ask");
  });

  it("fetches only the Pricing market-rollups weekly series and stats endpoints", async () => {
    const requested = [];
    const responses = [
      { items: [{ day: "2026-07-20" }] },
      { statHygiene: { minimumTradeSample: 3 }, marketState: null },
    ];
    const source = await loadCampaignMarketData(
      {
        apiBaseUrl: "https://marketplace.staging.chasesets.com/api/marketplace/",
        catalogItemId: "cat 1",
        productId: "prod/1",
        title: "Card",
        game: "Game",
        community: "r/game",
        from: "2026-07-20",
        to: "2026-07-26",
        asOf: "2026-07-26",
      },
      {
        fetch: async (url) => {
          requested.push(url);
          return { ok: true, json: async () => responses.shift() };
        },
      },
    );

    expect(requested).toEqual([
      "https://marketplace.staging.chasesets.com/api/marketplace/market-rollups/cat%201/prod%2F1/series?from=2026-07-20&to=2026-07-26&granularity=weekly",
      "https://marketplace.staging.chasesets.com/api/marketplace/market-rollups/cat%201/prod%2F1/stats",
    ]);
    expect(source.range).toEqual({ from: "2026-07-20", to: "2026-07-26", asOf: "2026-07-26" });
  });
});
