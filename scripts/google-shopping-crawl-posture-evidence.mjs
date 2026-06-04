#!/usr/bin/env node
import { fileURLToPath } from "node:url";

export const GOOGLE_SHOPPING_CRAWL_POSTURE_EVIDENCE_VERSION = "google-shopping-crawl-posture-evidence/v1";
export const GOOGLE_SHOPPING_PRODUCTION_MARKETPLACE_ORIGIN = "https://marketplace.chasesets.com";

export function parseGoogleShoppingCrawlPostureArgs(argv, env = process.env) {
  return {
    baseUrl: readOption(argv, "--base-url") ?? readEnv("GOOGLE_SHOPPING_CRAWL_BASE_URL", env),
    expectedIndexing: parseBoolean(
      readOption(argv, "--expect-indexing") ?? readEnv("GOOGLE_SHOPPING_EXPECT_INDEXING", env) ?? "true",
    ),
    sampledFeedLinks: readRepeatedOption(argv, "--sample-url"),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runGoogleShoppingCrawlPostureEvidence(options, fetchImpl = fetch) {
  const baseUrl = normalizeOrigin(options.baseUrl);
  const sampledFeedLinks = (options.sampledFeedLinks ?? []).map((value) => new URL(value, baseUrl).toString());
  const [robots, sitemap, ...samplePages] = await Promise.all([
    fetchText(fetchImpl, `${baseUrl}/robots.txt`),
    fetchText(fetchImpl, `${baseUrl}/sitemap.xml`),
    ...sampledFeedLinks.map((link) => fetchText(fetchImpl, link)),
  ]);

  return buildGoogleShoppingCrawlPostureEvidence({
    baseUrl,
    expectedIndexing: options.expectedIndexing,
    sampledFeedLinks,
    checkedAt: options.checkedAt,
    robotsText: robots.body,
    robotsStatus: robots.status,
    sitemapXml: sitemap.body,
    sitemapStatus: sitemap.status,
    canonicalHtmlByUrl: Object.fromEntries(
      sampledFeedLinks.map((link, index) => [link, samplePages[index]?.body ?? ""]),
    ),
    sampleStatusByUrl: Object.fromEntries(
      sampledFeedLinks.map((link, index) => [link, samplePages[index]?.status ?? 0]),
    ),
  });
}

export function buildGoogleShoppingCrawlPostureEvidence(input) {
  const baseUrl = normalizeOrigin(input.baseUrl);
  const productionOrigin = baseUrl === GOOGLE_SHOPPING_PRODUCTION_MARKETPLACE_ORIGIN;
  const sampledFeedLinks = (input.sampledFeedLinks ?? []).map((value) => new URL(value, baseUrl).toString());
  const robotsAllowsAll = allowsAllCrawlers(input.robotsText);
  const robotsDisallowsAll = disallowsAllCrawlers(input.robotsText);
  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  const declaredSitemapUrls = sitemapDeclarations(input.robotsText);
  const missingSitemapLinks = sampledFeedLinks.filter((link) => !sitemapContainsUrl(input.sitemapXml, link));
  const canonicalChecks = sampledFeedLinks.map((link) => {
    const canonicalUrl = extractCanonicalHref(input.canonicalHtmlByUrl?.[link] ?? "");
    return {
      url: link,
      status: input.sampleStatusByUrl?.[link] ?? null,
      canonicalUrl,
      matchesFeedLink: canonicalUrl === link,
    };
  });
  const errors = [];

  if (input.expectedIndexing) {
    if (!productionOrigin) {
      errors.push(
        "Google Shopping crawl posture must use https://marketplace.chasesets.com when indexing is expected.",
      );
    }
    if ((input.robotsStatus ?? 200) !== 200) {
      errors.push("robots.txt must return HTTP 200 when indexing is expected.");
    }
    if (!robotsAllowsAll || robotsDisallowsAll) {
      errors.push("robots.txt must allow crawlers when Google Shopping indexing is expected.");
    }
    if (!declaredSitemapUrls.includes(sitemapUrl)) {
      errors.push("robots.txt must declare the marketplace sitemap URL.");
    }
    if ((input.sitemapStatus ?? 200) !== 200) {
      errors.push("sitemap.xml must return HTTP 200 when indexing is expected.");
    }
    if (missingSitemapLinks.length > 0) {
      errors.push("Every sampled eligible feed link must appear in sitemap.xml.");
    }
    for (const check of canonicalChecks) {
      if (check.status !== null && check.status !== 200) {
        errors.push(`Sampled feed link ${check.url} must return HTTP 200.`);
      }
      if (!check.matchesFeedLink) {
        errors.push(`Sampled feed link ${check.url} must render a matching canonical URL.`);
      }
    }
  } else if (!robotsDisallowsAll) {
    errors.push("Noindex marketplace environments must disallow crawlers in robots.txt.");
  }

  return {
    schemaVersion: GOOGLE_SHOPPING_CRAWL_POSTURE_EVIDENCE_VERSION,
    baseUrl,
    checkedAt: input.checkedAt,
    expectedIndexing: input.expectedIndexing,
    productionOrigin,
    robots: {
      status: input.robotsStatus ?? null,
      allowsAll: robotsAllowsAll,
      disallowsAll: robotsDisallowsAll,
      declaredSitemapUrls,
    },
    sitemap: {
      status: input.sitemapStatus ?? null,
      url: sitemapUrl,
      sampledFeedLinks,
      missingSampledFeedLinks: missingSitemapLinks,
    },
    canonical: {
      checks: canonicalChecks,
      mismatches: canonicalChecks.filter((check) => !check.matchesFeedLink),
    },
    merchantFeedSubmissionAllowed: input.expectedIndexing && productionOrigin && errors.length === 0,
    passesGoogleShoppingCrawlPostureGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv) {
  const options = parseGoogleShoppingCrawlPostureArgs(argv);
  if (!options.baseUrl) {
    console.error(
      "Usage: node ./scripts/google-shopping-crawl-posture-evidence.mjs --base-url <url> [--sample-url <url>...]",
    );
    return 2;
  }

  const evidence = await runGoogleShoppingCrawlPostureEvidence(options);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passesGoogleShoppingCrawlPostureGate) {
    console.error("Google Shopping crawl posture evidence failed.");
    return 1;
  }
  return 0;
}

async function fetchText(fetchImpl, url) {
  const response = await fetchImpl(url);
  return { status: response.status, body: await response.text() };
}

function allowsAllCrawlers(value) {
  return /(^|\n)\s*Allow:\s*\/\s*(\n|$)/i.test(value ?? "");
}

function disallowsAllCrawlers(value) {
  return /(^|\n)\s*Disallow:\s*\/\s*(\n|$)/i.test(value ?? "");
}

function sitemapDeclarations(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^Sitemap:\s*(\S+)\s*$/i.exec(line.trim());
      return match ? [match[1]] : [];
    });
}

function sitemapContainsUrl(xml, url) {
  return String(xml ?? "").includes(escapeXml(url));
}

function extractCanonicalHref(html) {
  const linkTags = String(html ?? "").match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/\s([a-zA-Z:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1].toLowerCase(), match[2]]),
    );
    if (attributes.rel?.split(/\s+/).includes("canonical") && attributes.href) {
      return attributes.href;
    }
  }
  return null;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function normalizeOrigin(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseBoolean(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return true;
}

function readEnv(name, env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function readRepeatedOption(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
