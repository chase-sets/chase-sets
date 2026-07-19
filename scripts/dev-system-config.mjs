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
  command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: Object.freeze(["--filter", "@chase-sets/app-platform-worker", "run", "dev:ci"]),
});

const packageManagerCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const browserE2eProductionTarget = "browser-e2e-production";

export const browserE2eProductionCommands = Object.freeze({
  "platform-api": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-platform-api", "run", "start"]),
  }),
  "platform-worker": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-platform-worker", "run", "start"]),
  }),
  "admin-web": Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-admin-web", "run", "start"]),
  }),
  marketplace: Object.freeze({
    command: packageManagerCommand,
    args: Object.freeze(["--filter", "@chase-sets/app-marketplace-web", "run", "start"]),
  }),
});

export const browserE2eProductionBuilds = Object.freeze([
  Object.freeze({ name: "admin-web", workspace: "@chase-sets/app-admin-web" }),
  Object.freeze({ name: "marketplace", workspace: "@chase-sets/app-marketplace-web" }),
]);

export const browserE2eDirectCiCommands = Object.freeze({
  "platform-worker": browserE2ePlatformWorkerCiCommand,
});

export function resolveBrowserE2eSystemTarget(environment = process.env) {
  const mode = environment.CHASE_SETS_BROWSER_E2E_SYSTEM ?? "development";
  if (mode === "development") {
    return "browser-e2e";
  }
  if (mode === "production") {
    return browserE2eProductionTarget;
  }
  throw new Error(`CHASE_SETS_BROWSER_E2E_SYSTEM must be "development" or "production"; received "${mode}".`);
}

export function isBrowserE2eTarget(targetName) {
  return targetName === "browser-e2e" || targetName === browserE2eProductionTarget;
}

export function applyDevTargetEnvOverrides(targetName, processDefinitions, { ci = Boolean(process.env.CI) } = {}) {
  if (!isBrowserE2eTarget(targetName)) {
    return processDefinitions;
  }

  return processDefinitions.map((definition) => {
    const productionCommand =
      targetName === browserE2eProductionTarget ? browserE2eProductionCommands[definition.name] : undefined;

    if (definition.name === "platform-api") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2eRateLimitEnv,
          ...browserE2ePlatformAdminEnv,
          ...browserE2eReadConsistencyEnv,
        },
        ...(productionCommand ?? (ci ? browserE2eDirectCiCommands[definition.name] : {})),
      };
    }

    if (definition.name === "platform-worker") {
      return {
        ...definition,
        env: {
          ...definition.env,
          ...browserE2ePlatformWorkerEnv,
        },
        ...(productionCommand ?? (ci ? browserE2eDirectCiCommands[definition.name] : {})),
      };
    }

    if (productionCommand) {
      return {
        ...definition,
        ...productionCommand,
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
