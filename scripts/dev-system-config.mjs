export const browserE2eRateLimitEnv = Object.freeze({
  CHASE_SETS_RATE_LIMITS_DISABLED: "true",
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
          },
        }
      : definition,
  );
}
