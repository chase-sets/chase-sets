function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function validateHttpUrl(value, label) {
  if (!value) {
    return value;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${label} must include an http(s) scheme and hostname.`);
  }

  return value;
}

export function resolvePlatformSmokeUrls({ cliArgs, env, sandboxEnv }) {
  function getExplicitEnv(name) {
    return env[name] ?? "";
  }

  function getConfiguredUrl(primaryName, cliValue, fallbackName, options = {}) {
    const explicitValue = getExplicitEnv(primaryName) || (fallbackName ? getExplicitEnv(fallbackName) : "");
    if (explicitValue) {
      return explicitValue;
    }

    if (cliValue) {
      return cliValue;
    }

    if (options.includeSandboxFallback === false) {
      return "";
    }

    return sandboxEnv[primaryName] || (fallbackName ? sandboxEnv[fallbackName] : "") || "";
  }

  const hasExplicitCoreTarget = Boolean(
    cliArgs[0] ||
    cliArgs[1] ||
    getExplicitEnv("LANDING_WEB_URL") ||
    getExplicitEnv("PUBLIC_WEB_URL") ||
    getExplicitEnv("ADMIN_WEB_URL"),
  );

  return {
    landingUrl: validateHttpUrl(
      trimTrailingSlash(getConfiguredUrl("LANDING_WEB_URL", cliArgs[0] || "", "PUBLIC_WEB_URL")),
      "landing URL",
    ),
    adminUrl: validateHttpUrl(trimTrailingSlash(getConfiguredUrl("ADMIN_WEB_URL", cliArgs[1] || "")), "admin URL"),
    marketplaceUrl: validateHttpUrl(
      trimTrailingSlash(
        getConfiguredUrl("MARKETPLACE_WEB_URL", cliArgs[2] || "", undefined, {
          includeSandboxFallback: !hasExplicitCoreTarget,
        }),
      ),
      "marketplace URL",
    ),
    marketplaceRootUrl: validateHttpUrl(
      trimTrailingSlash(getConfiguredUrl("MARKETPLACE_ROOT_WEB_URL", "")),
      "marketplace root URL",
    ),
    redirectUrl: validateHttpUrl(
      trimTrailingSlash(
        getConfiguredUrl("LEGACY_PUBLIC_URL", cliArgs[3] || "", undefined, {
          includeSandboxFallback: !hasExplicitCoreTarget,
        }),
      ),
      "legacy redirect URL",
    ),
  };
}
