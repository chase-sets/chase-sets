const DEFAULT_SYNTHETIC_EMAIL = "ops+smoke@chasesets.com";

function envValue(env, sandboxEnv, name) {
  return env[name] ?? sandboxEnv[name] ?? "";
}

function sanitizeEmailSuffix(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function githubRunSuffix(env, sandboxEnv) {
  const runId = envValue(env, sandboxEnv, "GITHUB_RUN_ID");
  if (!runId) {
    return "";
  }

  const runAttempt = envValue(env, sandboxEnv, "GITHUB_RUN_ATTEMPT");
  return runAttempt ? `gh-${runId}-${runAttempt}` : `gh-${runId}`;
}

function appendEmailSuffix(email, suffix) {
  const safeSuffix = sanitizeEmailSuffix(suffix);
  if (!safeSuffix) {
    return email;
  }

  const atIndex = email.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return email;
  }

  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);
  const separator = localPart.includes("+") ? "-" : "+";
  return `${localPart}${separator}${safeSuffix}@${domain}`;
}

export function resolveSyntheticWaitlistEmail({ env = {}, sandboxEnv = {} } = {}) {
  const explicitEmail = envValue(env, sandboxEnv, "SMOKE_WAITLIST_EMAIL");
  if (explicitEmail) {
    return explicitEmail;
  }

  const baseEmail = envValue(env, sandboxEnv, "SMOKE_EMAIL") || DEFAULT_SYNTHETIC_EMAIL;
  const suffix = envValue(env, sandboxEnv, "SMOKE_EMAIL_SUFFIX") || githubRunSuffix(env, sandboxEnv);
  return appendEmailSuffix(baseEmail, suffix);
}
