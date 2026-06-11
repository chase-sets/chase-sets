#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateMarketplaceLaunchEvidence } from "./marketplace-launch-evidence.mjs";
import {
  OPTIONAL_LAUNCH_ENV_VARIABLES,
  REQUIRED_LAUNCH_ENV_VARIABLES,
} from "./marketplace-production-env-snapshot.mjs";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const MARKETPLACE_PRODUCTION_ENV_COMMANDS_VERSION = "marketplace-production-env-commands/v1";

export function parseProductionEnvCommandsArgs(argv, env = process.env) {
  return {
    packetPath: readOption(argv, "--file") ?? readEnv("MARKETPLACE_LAUNCH_EVIDENCE_PACKET", env),
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
  };
}

export async function runProductionEnvCommands(options) {
  const packet = JSON.parse(await readFile(options.packetPath, "utf8"));
  const validation = validateMarketplaceLaunchEvidence(packet);
  if (!validation.ok) {
    throw new Error(
      [
        "Marketplace launch evidence packet must pass before producing GitHub Environment commands.",
        ...validation.errors.map((error) => `- ${error}`),
      ].join("\n"),
    );
  }

  return buildProductionEnvCommands({
    productionEnvironment: packet.productionEnvironment,
    environmentName: options.environmentName,
  });
}

export function buildProductionEnvCommands(input) {
  const productionEnvironment = requireRecord(input.productionEnvironment, "productionEnvironment");
  const environmentName = requireString(input.environmentName ?? "production", "GitHub Environment name");
  const commands = [];
  const errors = [];

  for (const name of [...REQUIRED_LAUNCH_ENV_VARIABLES, ...OPTIONAL_LAUNCH_ENV_VARIABLES]) {
    const value = productionEnvironment[name];
    if (!isNonEmptyString(value)) {
      continue;
    }
    if (!/^[A-Z0-9_]+$/.test(name)) {
      errors.push(`Invalid GitHub Environment variable name ${name}.`);
      continue;
    }
    commands.push(
      `gh variable set ${name} --env ${escapePowerShellDoubleQuoted(environmentName)} --body ${escapePowerShellDoubleQuoted(value)}`,
    );
  }

  return {
    schemaVersion: MARKETPLACE_PRODUCTION_ENV_COMMANDS_VERSION,
    environmentName,
    commandCount: commands.length,
    commands,
    passesProductionEnvCommandsGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const options = parseProductionEnvCommandsArgs(argv, env);
  const optionErrors = validateOptions(options);
  if (optionErrors.length > 0) {
    for (const error of optionErrors) {
      console.error(error);
    }
    return 2;
  }

  try {
    const result = await runProductionEnvCommands(options);
    for (const command of result.commands) {
      console.log(command);
    }
    return result.passesProductionEnvCommandsGate ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function validateOptions(options) {
  const errors = [];
  if (!isNonEmptyString(options.packetPath)) {
    errors.push("MARKETPLACE_LAUNCH_EVIDENCE_PACKET or --file is required.");
  }
  return errors;
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function requireString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function escapePowerShellDoubleQuoted(value) {
  return `"${String(value).replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
