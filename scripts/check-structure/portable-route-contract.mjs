const deliveries = new Set(["portable", "web-resource-only", "server-only"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validatePortableRouteContract({ contextName, deployable, route }) {
  if (deployable !== "marketplace-web") return [];
  const violations = [];
  const add = (message) => violations.push(message);

  if (!deliveries.has(route.delivery)) add("delivery must be portable, web-resource-only, or server-only");
  if (route.sourceContext !== contextName) add("sourceContext must match the owning bounded context");
  if (!isNonEmptyString(route.pageComponentExport)) add("pageComponentExport must identify the page component");
  if (route.availability?.web !== true || typeof route.availability?.mobile !== "boolean") {
    add("availability must explicitly declare web=true and a boolean mobile value");
  }
  if (route.authorization?.kind !== "public" && route.authorization?.kind !== "authenticated") {
    add("authorization must be public or authenticated");
  }
  if (route.authorization?.kind === "authenticated" && !Array.isArray(route.authorization.requiredPermissions)) {
    add("authenticated routes must declare requiredPermissions");
  }
  if (route.canonicalLink?.kind !== "route-derived" && route.canonicalLink?.kind !== "not-applicable") {
    add("canonicalLink must declare route-derived or not-applicable intent");
  }
  if (route.canonicalLink?.kind === "not-applicable" && !isNonEmptyString(route.canonicalLink.reason)) {
    add("not-applicable canonicalLink intent must include a reason");
  }

  if (route.delivery === "portable") {
    if (route.availability?.mobile !== true) add("portable routes must be mobile available");
    if (route.portableDataOperations?.load !== true) add("portable routes must declare a load operation");
    if (typeof route.portableDataOperations?.mutation !== "boolean") {
      add("portable routes must explicitly declare mutation capability");
    }
    if (route.unsupportedMobile !== undefined) add("portable routes cannot carry unsupportedMobile inventory");
  } else if (route.delivery === "server-only" || route.delivery === "web-resource-only") {
    if (route.availability?.mobile !== false) add("unsupported routes must set mobile availability to false");
    if (!isNonEmptyString(route.unsupportedMobile?.owner)) add("unsupported routes must identify an owner");
    if (!isNonEmptyString(route.unsupportedMobile?.followUp)) add("unsupported routes must identify a follow-up");
    if (!isNonEmptyString(route.unsupportedMobile?.reason)) add("unsupported routes must explain their exclusion");
  }

  return violations;
}
