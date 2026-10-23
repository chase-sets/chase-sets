#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { validateLockCreationDeadline, validateLockExitRoute } from "./release-lock.mjs";

export const RELEASE_LOCK_COMMANDS_VERSION = "release-lock-commands/v2";
export const RELEASE_LOCK_METADATA_NAMES = [
  "PRODUCTION_RELEASE_LOCK_REASON",
  "PRODUCTION_RELEASE_LOCK_REFERENCE",
  "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE",
  "PRODUCTION_RELEASE_LOCK_DEADLINE",
];
const RELEASE_LOCK_VARIABLE_PREFIX = "PRODUCTION_RELEASE_LOCK_";

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
            ...Object.fromEntries(RELEASE_LOCK_METADATA_NAMES.map((name) => [name, null])),
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
        ? Object.entries(variables).flatMap(([name, value]) =>
            action === "unlock" && RELEASE_LOCK_METADATA_NAMES.includes(name) ? [[name, null]] : [[name, value]],
          )
        : [];
  const commands =
    errors.length === 0
      ? orderedVariables.map(([name, value]) =>
          value === null
            ? `gh variable delete ${name} --env ${escapePowerShellDoubleQuoted(environmentName)}`
            : `gh variable set ${name} --env ${escapePowerShellDoubleQuoted(environmentName)} --body ${escapePowerShellDoubleQuoted(value)}`,
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

/**
 * Evaluates the structured result of `gh variable list --env <name>` after a
 * printed unlock command sequence. The list operation is the only completion
 * authority; individual delete results are intentionally not accepted here.
 */
export function evaluateReleaseLockClearReadback(readback) {
  if (!readback || typeof readback !== "object" || Array.isArray(readback)) {
    return incompleteReadback("readback must be an object.");
  }
  if (readback.ok !== true) {
    return incompleteReadback(readback.error ?? "GitHub Environment variable list failed.");
  }

  let variables = readback.variables;
  if (variables === undefined && typeof readback.output === "string") {
    try {
      variables = JSON.parse(readback.output);
    } catch {
      return incompleteReadback("GitHub Environment variable list output was not parseable JSON.");
    }
  }
  if (!Array.isArray(variables)) {
    return incompleteReadback("GitHub Environment variable list output was not a variable array.");
  }

  const names = new Set();
  const values = new Map();
  for (const variable of variables) {
    if (!variable || typeof variable !== "object" || typeof variable.name !== "string") {
      return incompleteReadback("GitHub Environment variable list output contained an unparseable variable.");
    }
    if (names.has(variable.name)) {
      return incompleteReadback(`GitHub Environment variable list repeated ${variable.name}.`);
    }
    names.add(variable.name);
    values.set(variable.name, variable.value);
  }

  const errors = [];
  if (values.get("PRODUCTION_RELEASE_LOCKED") !== "false") {
    errors.push("PRODUCTION_RELEASE_LOCKED must be exactly false in the clear readback.");
  }
  const presentMetadata = RELEASE_LOCK_METADATA_NAMES.filter((name) => names.has(name));
  if (presentMetadata.length > 0) {
    errors.push(`Release lock metadata remains present: ${presentMetadata.join(", ")}.`);
  }
  const unknownMetadata = [...names].filter(
    (name) =>
      name.startsWith(RELEASE_LOCK_VARIABLE_PREFIX) &&
      name !== "PRODUCTION_RELEASE_LOCKED" &&
      !RELEASE_LOCK_METADATA_NAMES.includes(name),
  );
  if (unknownMetadata.length > 0) {
    errors.push(`Unknown release lock metadata remains present: ${unknownMetadata.join(", ")}.`);
  }
  return {
    complete: errors.length === 0,
    presentMetadata,
    unknownMetadata,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function incompleteReadback(error) {
  return { complete: false, presentMetadata: [], unknownMetadata: [], errors: [error] };
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
