export type ReleaseLockStatus = Readonly<{
  locked: boolean;
  reason: string;
  reference: string;
  environmentName: string;
}>;

export type ReleaseLockCommandInput = Readonly<{
  action: "lock" | "unlock";
  environmentName: string;
  reason?: string;
  reference?: string;
}>;

export type ReleaseLockCommandPlan = Readonly<{
  action: "lock" | "unlock";
  environmentName: string;
  commands: readonly string[];
  errors: readonly string[];
  ready: boolean;
}>;

export function readReleaseLockStatus(
  env: Readonly<Record<string, string | undefined>>,
  environmentName = "production",
): ReleaseLockStatus {
  return {
    locked: env.PRODUCTION_RELEASE_LOCKED === "true",
    reason: env.PRODUCTION_RELEASE_LOCK_REASON?.trim() ?? "",
    reference: env.PRODUCTION_RELEASE_LOCK_REFERENCE?.trim() ?? "",
    environmentName,
  };
}

export function buildReleaseLockCommandPlan(input: ReleaseLockCommandInput): ReleaseLockCommandPlan {
  const environmentName = requiredText(input.environmentName, "GitHub Environment name");
  const action = input.action;
  const reason = input.reason?.trim() ?? "";
  const reference = input.reference?.trim() ?? "";
  const errors = action === "lock" && reason.length === 0 ? ["Lock reason is required."] : [];
  const variables =
    action === "lock"
      ? {
          PRODUCTION_RELEASE_LOCKED: "true",
          PRODUCTION_RELEASE_LOCK_REASON: reason,
          PRODUCTION_RELEASE_LOCK_REFERENCE: reference,
        }
      : {
          PRODUCTION_RELEASE_LOCKED: "false",
          PRODUCTION_RELEASE_LOCK_REASON: "",
          PRODUCTION_RELEASE_LOCK_REFERENCE: "",
        };

  return {
    action,
    environmentName,
    commands: Object.entries(variables).map(
      ([name, value]) =>
        `gh variable set ${name} --env ${escapePowerShellDoubleQuoted(environmentName)} --body ${escapePowerShellDoubleQuoted(value)}`,
    ),
    errors,
    ready: errors.length === 0,
  };
}

function requiredText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return normalized;
}

function escapePowerShellDoubleQuoted(value: string) {
  return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}
