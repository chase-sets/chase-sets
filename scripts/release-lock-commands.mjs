#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { validateLockCreationDeadline, validateLockExitRoute } from "./release-lock.mjs";

export const RELEASE_LOCK_COMMANDS_VERSION = "release-lock-commands/v2";

export function parseReleaseLockCommandsArgs(argv, env = process.env) {
  return {
    action: readOption(argv, "--action") ?? readEnv("RELEASE_LOCK_ACTION", env) ?? "",
    environmentName: readOption(argv, "--environment") ?? readEnv("GITHUB_ENVIRONMENT_NAME", env) ?? "production",
    reason: readOption(argv, "--reason") ?? readEnv("PRODUCTION_RELEASE_LOCK_REASON", env) ?? "",
    reference: readOption(argv, "--reference") ?? readEnv("PRODUCTION_RELEASE_LOCK_REFERENCE", env) ?? "",
    exitRoute: readOption(argv, "--exit-route") ?? env.PRODUCTION_RELEASE_LOCK_EXIT_ROUTE ?? "",
    deadline: readOption(argv, "--deadline") ?? readEnv("PRODUCTION_RELEASE_LOCK_DEADLINE", env) ?? "",
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
          PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: input.exitRoute ?? "",
          PRODUCTION_RELEASE_LOCK_DEADLINE: input.deadline ?? "",
        }
      : action === "unlock"
        ? {
            PRODUCTION_RELEASE_LOCKED: "false",
            PRODUCTION_RELEASE_LOCK_REASON: "",
            PRODUCTION_RELEASE_LOCK_REFERENCE: "",
            PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: "",
            PRODUCTION_RELEASE_LOCK_DEADLINE: "",
          }
        : null;

  if (!variables) {
    errors.push("release lock action must be lock or unlock.");
  }

  if (action === "lock" && !isNonEmptyString(input.reason)) {
    errors.push("PRODUCTION_RELEASE_LOCK_REASON is required when locking production releases.");
  }
  if (action === "lock") {
    const route = validateLockExitRoute(input.exitRoute);
    errors.push(...route.errors);
    const deadline = validateLockCreationDeadline(input.deadline);
    errors.push(...deadline.errors);
  }

  const orderedVariables =
    variables && action === "lock"
      ? Object.entries(variables)
          .filter(([name]) => name !== "PRODUCTION_RELEASE_LOCKED")
          .concat([["PRODUCTION_RELEASE_LOCKED", "true"]])
      : variables
        ? Object.entries(variables)
        : [];
  const commands =
    errors.length === 0
      ? orderedVariables.map(
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
  return `"${String(value)
    .replaceAll("`", "``")
    .replace(/[“”„]/g, (quote) => `\`${quote}`)
    .replaceAll("$", "`$")
    .replaceAll('"', '`"')}"`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
