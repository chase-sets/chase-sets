// Shared CLI-option and environment helpers for the operational scripts in
// scripts/, used by the evidence, readiness, and canary generators so the
// parsing logic lives in one place.

export function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

export function readRepeatedOptions(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.push(argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

export function readEnv(name, env = process.env) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

export function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}
