export const browserE2eRateLimitEnv = Object.freeze({
  CHASE_SETS_RATE_LIMITS_DISABLED: "true",
});

export const browserE2ePlatformAdminEnv = Object.freeze({
  PLATFORM_ADMIN_EMAIL: "browser-e2e-platform-admin@chasesets.test",
  PLATFORM_ADMIN_PASSWORD: "browser-e2e-platform-admin-password",
});

export function applyDevTargetEnvOverrides(targetName, processDefinitions) {
  if (targetName !== "browser-e2e") {
    return processDefinitions;
  }

  return processDefinitions.map((definition) =>
    definition.name === "platform-api"
      ? {
          ...definition,
          env: {
            ...definition.env,
            ...browserE2eRateLimitEnv,
            ...browserE2ePlatformAdminEnv,
          },
        }
      : definition,
  );
}
