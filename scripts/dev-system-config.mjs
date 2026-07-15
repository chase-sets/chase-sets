export const browserE2eRateLimitEnv = Object.freeze({
  CHASE_SETS_RATE_LIMITS_DISABLED: "true",
});

export const browserE2ePlatformAdminEnv = Object.freeze({
  PLATFORM_ADMIN_EMAIL: "browser-e2e-platform-admin@chasesets.test",
  PLATFORM_ADMIN_PASSWORD: "browser-e2e-platform-admin-password",
});

export const browserE2eReadConsistencyEnv = Object.freeze({
  READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED: "true",
});

export const browserE2eProjectionWakeEnv = Object.freeze({
  WORKER_WAKE_HOT_LANE_RUNNER_COUNT: "2",
  WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "4",
  WORKER_WAKE_POLL_INTERVAL_MS: "250",
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
            ...browserE2eReadConsistencyEnv,
          },
        }
      : definition.name === "platform-worker"
        ? {
            ...definition,
            env: {
              ...definition.env,
              ...browserE2eProjectionWakeEnv,
            },
          }
        : definition,
  );
}
