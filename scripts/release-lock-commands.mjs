#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

export const RELEASE_LOCK_COMMANDS_VERSION = "release-lock-commands/v1";

export function parseReleaseLockCommandsArgs(argv, env = process.env) {
  return {
    action: readOption(argv, "--action") ?? readEnv("RELEASE_LOCK_ACTION", env) ?? "",
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
    reason: readOption(argv, "--reason") ?? readEnv("PRODUCTION_RELEASE_LOCK_REASON", env) ?? "",
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_RELEASE_LOCK_REFERENCE", env) ?? "",
  };
}

export function buildReleaseLockCommands(input) {
  const action = requireString(input.action, "release lock action");
  const environmentName = requireString(input.environmentName ?? "production", "GitHub Environment name");
  const errors = [];
  const variables =
    action === "lock"
      ? {
          PRODUCTION_RELEASE_LOCKED: "true",
          PRODUCTION_RELEASE_LOCK_REASON: input.reason ?? "",
          PRODUCTION_RELEASE_LOCK_REFERENCE: input.reference ?? "",
        }
      : action === "unlock"
        ? {
            PRODUCTION_RELEASE_LOCKED: "false",
            PRODUCTION_RELEASE_LOCK_REASON: "",
            PRODUCTION_RELEASE_LOCK_REFERENCE: "",
          }
        : null;

  if (!variables) {
    errors.push("release lock action must be lock or unlock.");
  }

  if (action === "lock" && !isNonEmptyString(input.reason)) {
    errors.push("PRODUCTION_RELEASE_LOCK_REASON is required when locking production releases.");
  }

  const commands = variables
    ? Object.entries(variables).map(
        ([name, value]) =>
          `gh variable set ${name} --env ${escapePowerShellDoubleQuoted(environmentName)} --body ${escapePowerShellDoubleQuoted(value)}`,
      )
    : [];

  return {
    schemaVersion: RELEASE_LOCK_COMMANDS_VERSION,
    action,
    environmentName,
    commandCount: commands.length,
    commands,
    passesReleaseLockCommandsGate: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

async function main(argv, env = process.env) {
  const result = buildReleaseLockCommands(parseReleaseLockCommandsArgs(argv, env));
  for (const command of result.commands) {
    console.log(command);
  }
  if (!result.passesReleaseLockCommandsGate) {
    for (const error of result.errors) {
      console.error(error);
    }
    return 1;
  }
  return 0;
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
