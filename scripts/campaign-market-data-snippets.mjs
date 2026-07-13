#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readOption } from "./lib/cli-options.mjs";

const ENVIRONMENTS = new Set(["fixture", "staging", "production"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d+(?:\.\d{2})$/;
const SIGNED_MONEY = /^-?\d+(?:\.\d{2})$/;
const API_SOURCES = {
  staging: "https://marketplace.staging.chasesets.com/api/marketplace",
  production: "https://marketplace.chasesets.com/api/marketplace",
};

export function parseCampaignMarketDataArgs(argv) {
  return {
    input: readOption(argv, "--input"),
    apiBaseUrl: readOption(argv, "--api-base-url"),
    environment: readOption(argv, "--source-environment") ?? (readOption(argv, "--input") ? "fixture" : null),
    catalogItemId: readOption(argv, "--catalog-item-id"),
    productId: readOption(argv, "--product-id"),
    title: readOption(argv, "--title"),
    game: readOption(argv, "--game"),
    community: readOption(argv, "--community"),
    from: readOption(argv, "--from"),
    to: readOption(argv, "--to"),
    asOf: readOption(argv, "--as-of"),
    out: readOption(argv, "--out"),
  };
}

export function validateCampaignMarketDataOptions(options) {
  const errors = [];
  if (!ENVIRONMENTS.has(options.environment)) {
    errors.push("--source-environment must be fixture, staging, or production.");
  }
  if (!options.out) errors.push("--out is required (path without an extension).");
  if (options.input) {
    if (options.environment !== "fixture")
      errors.push("--input is fixture-only and cannot be labeled staging or production.");
    if (options.apiBaseUrl) errors.push("Use exactly one source: --input or --api-base-url.");
  } else {
    for (const [flag, value] of [
      ["--api-base-url", options.apiBaseUrl],
      ["--catalog-item-id", options.catalogItemId],
      ["--product-id", options.productId],
      ["--title", options.title],
      ["--game", options.game],
      ["--community", options.community],
      ["--from", options.from],
      ["--to", options.to],
      ["--as-of", options.asOf],
    ]) {
      if (!value) errors.push(`${flag} is required for an API run.`);
    }
    if (options.environment === "fixture") errors.push("Fixture runs require --input.");
    if (options.apiBaseUrl && options.environment && options.environment !== "fixture") {
      let normalizedApiBaseUrl;
      try {
        const url = new URL(options.apiBaseUrl);
        normalizedApiBaseUrl = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
      } catch {
        errors.push("--api-base-url must be an absolute URL.");
      }
      const expectedApiBaseUrl = API_SOURCES[options.environment];
      if (normalizedApiBaseUrl && normalizedApiBaseUrl !== expectedApiBaseUrl) {
        errors.push(`--source-environment ${options.environment} requires --api-base-url ${expectedApiBaseUrl}.`);
      }
    }
  }
  if (options.from && !ISO_DATE.test(options.from)) errors.push("--from must be YYYY-MM-DD.");
  if (options.to && !ISO_DATE.test(options.to)) errors.push("--to must be YYYY-MM-DD.");
  if (options.asOf && !ISO_DATE.test(options.asOf)) errors.push("--as-of must be YYYY-MM-DD.");
  return errors;
}

function endpoint(baseUrl, catalogItemId, productId, suffix) {
  const root = baseUrl.replace(/\/$/, "");
  return `${root}/market-rollups/${encodeURIComponent(catalogItemId)}/${encodeURIComponent(productId)}/${suffix}`;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Pricing market-rollups request failed (${response.status}) for ${url}`);
  return response.json();
}

export async function loadCampaignMarketData(options, dependencies = {}) {
  if (options.input) {
    return JSON.parse(await (dependencies.readFile ?? readFile)(options.input, "utf8"));
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const seriesUrl = new URL(endpoint(options.apiBaseUrl, options.catalogItemId, options.productId, "series"));
  seriesUrl.searchParams.set("from", options.from);
  seriesUrl.searchParams.set("to", options.to);
  seriesUrl.searchParams.set("granularity", "weekly");
  const statsUrl = endpoint(options.apiBaseUrl, options.catalogItemId, options.productId, "stats");
  const [series, stats] = await Promise.all([
    fetchJson(fetchImpl, seriesUrl.toString()),
    fetchJson(fetchImpl, statsUrl),
  ]);

  return {
    schemaVersion: 1,
    subject: {
      catalogItemId: options.catalogItemId,
      productId: options.productId,
      title: options.title,
      game: options.game,
      community: options.community,
    },
    range: { from: options.from, to: options.to, asOf: options.asOf },
    series,
    stats,
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validMoneyOrNull(value) {
  return value === null || (typeof value === "string" && MONEY.test(value));
}

export function validateCampaignMarketDataSource(source) {
  const errors = [];
  if (source?.schemaVersion !== 1) errors.push("source.schemaVersion must be 1.");
  for (const field of ["catalogItemId", "productId", "title", "game", "community"]) {
    if (!nonEmpty(source?.subject?.[field])) errors.push(`source.subject.${field} is required.`);
  }
  for (const field of ["from", "to", "asOf"]) {
    if (!ISO_DATE.test(source?.range?.[field] ?? "")) errors.push(`source.range.${field} must be YYYY-MM-DD.`);
  }
  if (source?.range?.from > source?.range?.to) errors.push("source.range.from must not be after source.range.to.");
  if (source?.range?.to > source?.range?.asOf) errors.push("source.range.asOf must be on or after source.range.to.");
  const minimum = source?.stats?.statHygiene?.minimumTradeSample;
  if (!Number.isInteger(minimum) || minimum < 1)
    errors.push("source.stats.statHygiene.minimumTradeSample must be positive.");
  const items = source?.series?.items;
  if (!Array.isArray(items) || items.length === 0) errors.push("source.series.items must contain weekly rollup rows.");
  let previousDay = "";
  for (const [index, item] of (items ?? []).entries()) {
    const prefix = `source.series.items[${index}]`;
    if (!ISO_DATE.test(item?.day ?? "")) errors.push(`${prefix}.day must be YYYY-MM-DD.`);
    if (item?.day < source?.range?.from || item?.day > source?.range?.to)
      errors.push(`${prefix}.day must fall inside source.range.`);
    if (item?.day <= previousDay) errors.push("source.series.items must be strictly ordered by day.");
    previousDay = item?.day ?? previousDay;
    for (const field of [
      "firstPriceAmount",
      "lastPriceAmount",
      "minPriceAmount",
      "maxPriceAmount",
      "medianPriceAmount",
    ]) {
      if (!validMoneyOrNull(item?.[field]))
        errors.push(`${prefix}.${field} must be null or a non-negative money string.`);
    }
    for (const field of ["unitVolume", "tradeCount", "verifiedTradeCount"]) {
      if (!Number.isInteger(item?.[field]) || item[field] < 0)
        errors.push(`${prefix}.${field} must be a non-negative integer.`);
    }
    if (item?.verifiedTradeCount > item?.tradeCount)
      errors.push(`${prefix}.verifiedTradeCount cannot exceed tradeCount.`);
    if (item?.medianPriceAmount !== null && Number.isInteger(minimum) && item?.tradeCount < minimum)
      errors.push(`${prefix}.medianPriceAmount must be null below the stat-hygiene minimum sample.`);
  }
  const marketState = source?.stats?.marketState;
  if (marketState !== null && marketState !== undefined) {
    if (!ISO_DATE.test(marketState.day ?? "") || marketState.day > source?.range?.asOf)
      errors.push("source.stats.marketState.day must be YYYY-MM-DD on or before source.range.asOf.");
    for (const field of ["activeListingCount", "openOfferCount"]) {
      if (!Number.isInteger(marketState[field]) || marketState[field] < 0)
        errors.push(`source.stats.marketState.${field} must be a non-negative integer.`);
    }
  }
  for (const field of ["minAskAmount", "maxBidAmount"]) {
    if (!validMoneyOrNull(marketState?.[field] ?? null)) {
      errors.push(`source.stats.marketState.${field} must be null or a non-negative money string.`);
    }
  }
  if (marketState && marketState.spreadAmount !== null && !SIGNED_MONEY.test(marketState.spreadAmount ?? ""))
    errors.push("source.stats.marketState.spreadAmount must be null or a signed money string.");
  return errors;
}

function dollars(amount) {
  const value = Number(amount);
  return value < 0 ? `-$${Math.abs(value).toFixed(2)}` : `$${value.toFixed(2)}`;
}

function buildFacts(source) {
  const eligible = source.series.items.filter((point) => point.medianPriceAmount !== null);
  const first = eligible[0] ?? null;
  const last = eligible.at(-1) ?? null;
  return {
    tradeCount: source.series.items.reduce((sum, point) => sum + point.tradeCount, 0),
    unitVolume: source.series.items.reduce((sum, point) => sum + point.unitVolume, 0),
    verifiedTradeCount: source.series.items.reduce((sum, point) => sum + point.verifiedTradeCount, 0),
    weeklyMedians: eligible.map((point) => ({
      day: point.day,
      amount: point.medianPriceAmount,
      tradeCount: point.tradeCount,
    })),
    medianMovement:
      first && last && first.day !== last.day
        ? { fromDay: first.day, fromAmount: first.medianPriceAmount, toDay: last.day, toAmount: last.medianPriceAmount }
        : null,
    marketState: source.stats.marketState ?? null,
  };
}

function buildSnippetText(source, facts) {
  const label = `${source.subject.title} (${source.subject.game})`;
  const lines = [
    `${label}: ${facts.tradeCount} completed, non-excluded trades and ${facts.unitVolume} units in Chase Sets' product-level rollups from ${source.range.from} through ${source.range.to}.`,
  ];
  if (facts.medianMovement) {
    lines.push(
      `The truth-gated weekly median moved from ${dollars(facts.medianMovement.fromAmount)} (${facts.medianMovement.fromDay}) to ${dollars(facts.medianMovement.toAmount)} (${facts.medianMovement.toDay}).`,
    );
  } else {
    lines.push("No two weekly medians cleared Pricing's minimum-sample display gate, so no price movement is claimed.");
  }
  const market = facts.marketState;
  if (market && market.spreadAmount !== null && market.minAskAmount !== null && market.maxBidAmount !== null) {
    lines.push(
      `As of ${market.day}, the lowest active ask was ${dollars(market.minAskAmount)}, the highest open offer was ${dollars(market.maxBidAmount)}, and the recorded spread was ${dollars(market.spreadAmount)}.`,
    );
  }
  lines.push(
    "Data from the Chase Sets catalog. Product-level marketplace activity; not a game-wide price index or per-grade price guide.",
  );
  return lines.join(" ");
}

function buildXThread(source, facts) {
  const posts = [
    `${source.subject.title} (${source.subject.game})\n${source.range.from}–${source.range.to}: ${facts.tradeCount} completed, non-excluded trades; ${facts.unitVolume} units in Chase Sets' product-level rollups.`,
    facts.medianMovement
      ? `Truth-gated weekly median: ${dollars(facts.medianMovement.fromAmount)} (${facts.medianMovement.fromDay}) → ${dollars(facts.medianMovement.toAmount)} (${facts.medianMovement.toDay}).`
      : "No two weekly medians cleared Pricing's minimum-sample display gate, so no price movement is claimed.",
  ];
  const market = facts.marketState;
  if (market && market.spreadAmount !== null && market.minAskAmount !== null && market.maxBidAmount !== null) {
    posts.push(
      `As of ${market.day}: lowest active ask ${dollars(market.minAskAmount)}; highest open offer ${dollars(market.maxBidAmount)}; recorded spread ${dollars(market.spreadAmount)}.`,
    );
  }
  posts.push(
    "Data from the Chase Sets catalog. Product-level marketplace activity; not a game-wide price index or per-grade price guide.",
  );
  const oversized = posts.find((post) => post.length > 280);
  if (oversized) throw new Error("Generated X post exceeds 280 characters; use a shorter exact subject label.");
  return posts;
}

export function buildCampaignMarketDataArtifact(source, environment) {
  if (!ENVIRONMENTS.has(environment)) throw new Error("environment must be fixture, staging, or production.");
  const errors = validateCampaignMarketDataSource(source);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  const facts = buildFacts(source);
  const publishable = environment === "production";
  const text = buildSnippetText(source, facts);
  const xThread = buildXThread(source, facts);
  return {
    schemaVersion: 1,
    publication: {
      publishable,
      reason: publishable
        ? "Production Pricing market-rollups source; operator review still required."
        : `${environment} data is rehearsal-only and must not be published as live market activity.`,
    },
    source: {
      environment,
      readModel: "pricing market-rollups query API (Trades Tape-derived weekly rollups and market-state snapshot)",
      asOf: source.range.asOf,
      catalogItemId: source.subject.catalogItemId,
      productId: source.subject.productId,
    },
    subject: source.subject,
    range: source.range,
    facts,
    snippets: {
      x: xThread.join("\n\n"),
      xThread,
      redditTitle: `[Market data] ${source.subject.title} — ${source.range.from} to ${source.range.to}`,
      redditBody: `${text}\n\nSource note: generated from Chase Sets Pricing's Trades Tape-derived rollups. Community: ${source.subject.community}.`,
    },
  };
}

export function renderCampaignMarketDataMarkdown(artifact) {
  const banner = artifact.publication.publishable
    ? "PUBLISHABLE SOURCE — operator review required"
    : "DO NOT PUBLISH — FIXTURE/STAGING REHEARSAL";
  const xPosts = artifact.snippets.xThread.map((post, index) => `**Post ${index + 1}**\n\n${post}`).join("\n\n");
  return `# Campaign market-data snippet\n\n> **${banner}.** ${artifact.publication.reason}\n\n## X thread\n\n${xPosts}\n\n## Reddit\n\n**${artifact.snippets.redditTitle}**\n\n${artifact.snippets.redditBody}\n\n## Provenance\n\n- Environment: ${artifact.source.environment}\n- As of: ${artifact.source.asOf}\n- Catalog item: ${artifact.source.catalogItemId}\n- Product: ${artifact.source.productId}\n- Read model: ${artifact.source.readModel}\n`;
}

export async function writeCampaignMarketDataArtifact(out, artifact) {
  const directory = path.dirname(out);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(`${out}.json`, `${JSON.stringify(artifact, null, 2)}\n`),
    writeFile(`${out}.md`, renderCampaignMarketDataMarkdown(artifact)),
  ]);
}

async function main(argv) {
  const options = parseCampaignMarketDataArgs(argv);
  const errors = validateCampaignMarketDataOptions(options);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    return 2;
  }
  try {
    const source = await loadCampaignMarketData(options);
    const artifact = buildCampaignMarketDataArtifact(source, options.environment);
    await writeCampaignMarketDataArtifact(options.out, artifact);
    console.log(`${options.out}.md`);
    console.log(`${options.out}.json`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
