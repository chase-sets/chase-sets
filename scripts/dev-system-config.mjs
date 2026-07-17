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

export const browserE2ePlatformWorkerEnv = Object.freeze({
  // The support shard invokes this sweep explicitly and asserts its result.
  // Running the scheduled copy at worker startup consumes the fixtures first.
  SUPPORT_REQUEST_DEADLINE_SWEEP_INTERVAL_MS: "0",
});

export const browserE2ePlatformWorkerCiCommand = Object.freeze({
  command: process.execPath,
  args: Object.freeze([
    "node_modules/tsx/dist/cli.mjs",
    "--env-file=.env.example",
    "--env-file-if-exists=.env.local",
    "src/main.ts",
  ]),
  cwd: "deployables/platform-worker",
});

export const browserE2eDirectCiCommands = Object.freeze({
  "platform-worker": browserE2ePlatformWorkerCiCommand,
});

export function applyDevTargetEnvOverrides(targetName, processDefinitions, { ci = Boolean(process.env.CI) } = {}) {
  if (targetName !== "browser-e2e") {
    return processDefinitions;
  }

  return processDefinitions.map((definition) => {
    if (definition.name === "platform-api") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2eRateLimitEnv,
          ...browserE2ePlatformAdminEnv,
          ...browserE2eReadConsistencyEnv,
        },
        ...(ci ? browserE2eDirectCiCommands[definition.name] : {}),
      };
    }

    if (definition.name === "platform-worker") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2ePlatformWorkerEnv,
        },
        ...(ci ? browserE2eDirectCiCommands[definition.name] : {}),
      };
    }

    if (ci && browserE2eDirectCiCommands[definition.name]) {
      return {
        ...definition,
        ...browserE2eDirectCiCommands[definition.name],
      };
    }

    return definition;
  });
}
