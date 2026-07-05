#!/usr/bin/env node
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const defaultAttempts = 24;
const defaultDelayMs = 5000;

export async function probeIngressUrl(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable; run with Node.js 18 or newer.");
  }

  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: options.signal,
  });

  return {
    url,
    status: response.status,
    ok: response.status >= 200 && response.status < 400,
  };
}

export async function waitForIngressUrls(options) {
  const urls = normalizeUrls(options.urls);
  const attempts = options.attempts ?? defaultAttempts;
  const delayMs = options.delayMs ?? defaultDelayMs;
  const fetchImpl = options.fetchImpl;
  const sleepImpl = options.sleepImpl ?? sleep;
  let lastResults = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResults = await Promise.all(
      urls.map(async (url) => {
        try {
          return await probeIngressUrl(url, { fetchImpl });
        } catch (error) {
          return {
            url,
            status: null,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    if (lastResults.every((result) => result.ok)) {
      return { attempts: attempt, results: lastResults };
    }

    if (attempt < attempts) {
      await sleepImpl(delayMs);
    }
  }

  const failures = lastResults
    .filter((result) => !result.ok)
    .map((result) => `${result.url} -> ${result.status ?? result.error ?? "unknown"}`)
    .join(", ");
  throw new Error(`Ingress URL readiness timed out after ${attempts} attempt(s): ${failures}.`);
}

function normalizeUrls(urls) {
  const normalized = [...new Set((urls ?? []).map((url) => String(url).trim()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("At least one --url is required.");
  }

  for (const url of normalized) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Ingress readiness URL must use https: ${url}`);
    }
  }

  return normalized;
}

function parsePositiveInteger(value, flagName) {
  if (!/^\d+$/.test(String(value)) || Number(value) <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return Number(value);
}

function parseArgs(argv) {
  const options = {
    urls: [],
    attempts: defaultAttempts,
    delayMs: defaultDelayMs,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      options.urls.push(readNextArg(argv, ++index, arg));
    } else if (arg === "--attempts") {
      options.attempts = parsePositiveInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--delay-ms") {
      options.delayMs = parsePositiveInteger(readNextArg(argv, ++index, arg), arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(
        "Usage: node ./scripts/platform-ingress-wait.mjs --url <https-url> [--url <https-url>...] [--attempts <count>] [--delay-ms <ms>] [--dry-run]",
      );
    }
  }

  options.urls = normalizeUrls(options.urls);
  return options;
}

function readNextArg(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          urlCount: options.urls.length,
          urls: options.urls,
          attempts: options.attempts,
          delayMs: options.delayMs,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const result = await waitForIngressUrls(options);
  console.log(`Ingress URLs ready after ${result.attempts} attempt(s): ${options.urls.join(", ")}`);
  return 0;
}

if (process.argv[1]?.endsWith("platform-ingress-wait.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
