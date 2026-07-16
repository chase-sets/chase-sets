export const ADMIN_TOPOLOGY_MODES = ["staging", "public-marketplace", "production-platform-disabled"];
export const ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID = "SMOKE-API-MARKETPLACE-POSTAGE-POLICIES";

export const ADMIN_SHELL_SECTIONS = ["Access", "Catalog", "Commerce", "Growth", "Support", "Platform"];

export const ADMIN_PARTIAL_ACTORS = [
  {
    id: "AS-ACTOR-SECURITY-MANAGE",
    permission: "security.manage",
    expectedSections: ["Access"],
    expectedEntryPaths: ["/access"],
  },
  {
    id: "AS-ACTOR-PROJECTION-OPERATIONS-VIEW",
    permission: "projection-operations.view",
    expectedSections: ["Platform"],
    expectedEntryPaths: ["/platform", "/platform/projections"],
  },
  {
    id: "AS-ACTOR-MEMBERSHIPS-VIEW",
    permission: "memberships.view",
    expectedSections: ["Access"],
    expectedEntryPaths: ["/access", "/access/memberships"],
  },
  {
    id: "AS-ACTOR-PUBLIC-PRESENCE-VIEW",
    permission: "public-presence.view",
    expectedSections: ["Growth"],
    expectedEntryPaths: ["/growth", "/growth/waitlist"],
  },
  {
    id: "AS-ACTOR-POSTAGE-POLICIES-VIEW",
    permission: "postage-policies.view",
    expectedSections: ["Commerce"],
    expectedEntryPaths: ["/commerce", "/commerce/postage-policies"],
  },
  {
    id: "AS-ACTOR-PLATFORM-FEEDBACK-VIEW",
    permission: "platform-feedback.view",
    expectedSections: ["Support"],
    expectedEntryPaths: ["/support", "/support/platform-feedback"],
  },
];

export const ADMIN_PARTIAL_ACTOR_EVIDENCE_ROWS = ADMIN_PARTIAL_ACTORS.map((actor) => ({
  id: `EVIDENCE-${actor.id}`,
  actorId: actor.id,
  permission: actor.permission,
  expectedEntryPaths: actor.expectedEntryPaths,
  expectedSections: actor.expectedSections,
  evidenceFiles: [
    "deployables/admin-web/app/admin-section-loader.server.test.ts",
    "deployables/admin-web/app/host.test.ts",
  ],
  command: "pnpm --filter @chase-sets/app-admin-web run test -- admin-section-loader.server host",
}));

export const ADMIN_WEB_API_DEPENDENCIES = [
  {
    id: "API-AUTH-ACCESS-SESSIONS",
    section: "Access",
    surface: "Access Session Administration",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/auth/support/request-support/api-client.ts",
    apiPath: "/api/auth",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/auth",'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/auth",
    smokeCoverageId: "SMOKE-API-AUTH-ACCESS-SESSIONS",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "platform-api landing route or internal-origin",
      "production-platform-disabled": "platform-api landing route or internal-origin",
    },
  },
  {
    id: "API-IDENTITY-ACCESS-ADMIN",
    section: "Access",
    surface: "Access Identity Administration",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/identity/support/request-support/api-client.ts",
    apiPath: "/api/identity",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/identity")'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/identity",
    smokeCoverageId: "SMOKE-API-IDENTITY-ACCESS-ADMIN",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "platform-api landing route or internal-origin",
      "production-platform-disabled": "platform-api landing route or internal-origin",
    },
  },
  {
    id: "API-CATALOG-ADMIN-SERVER",
    section: "Catalog",
    surface: "Catalog Admin Server Loaders",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/catalog/support/request-support/api-client.ts",
    apiPath: "/api/catalog",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/catalog")'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/catalog",
    smokeCoverageId: "SMOKE-API-CATALOG-ADMIN-SERVER",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-COMMERCIAL-TERMS-ADMIN-SERVER",
    section: "Commerce",
    surface: "Commercial Terms Admin Server Loaders",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/commercial-terms/features/home/integrations/admin-api-client.ts",
    apiPath: "/api/commercial-terms",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/commercial-terms")'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/commercial-terms",
    smokeCoverageId: "SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER",
    topologyExpectations: {
      staging: "authenticated admin page/loader evidence",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-MARKETPLACE-POSTAGE-POLICIES",
    section: "Commerce",
    surface: "Commerce Postage Policies",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/ordering/client.ts",
    apiPath: "/api/marketplace/admin/postage-policies",
    sourceEvidence: ["admin/postage-policies"],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/marketplace",
    smokeCoverageId: ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID,
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-MARKETPLACE-GOOGLE-SHOPPING",
    section: "Growth",
    surface: "Growth Google Shopping",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/discovery/features/google-shopping-operations/api/request-client.ts",
    apiPath: "/api/marketplace/google-shopping",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/marketplace")', "google-shopping/feed-rows"],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/marketplace",
    smokeCoverageId: "SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-PUBLIC-PRESENCE-ADMIN-SERVER",
    section: "Growth",
    surface: "Public Presence Admin Server Loaders",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/public-presence/support/request-support/api-client.ts",
    apiPath: "/api/public-presence",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/public-presence")'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/public-presence",
    smokeCoverageId: "SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "platform-api landing route or internal-origin",
    },
  },
  {
    id: "API-MARKETPLACE-SUPPORT-REQUESTS",
    section: "Support",
    surface: "Support Request Operations",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/platform-operations/support/request-support/support-request-api-client.ts",
    apiPath: "/api/marketplace/support-requests/ops",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/marketplace")', "support-requests/ops"],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/marketplace",
    smokeCoverageId: "SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-EXPERIENCE-PLATFORM-FEEDBACK",
    section: "Support",
    surface: "Platform Feedback",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/platform-operations/support/request-support/api-client.ts",
    apiPath: "/api/experience",
    sourceEvidence: ['resolveRequestApiBaseUrl(request, "/api/experience")'],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/experience",
    smokeCoverageId: "SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "platform-api landing route or internal-origin",
    },
  },
  {
    id: "API-PLATFORM-PROJECTIONS",
    section: "Platform",
    surface: "Platform Projections",
    callerType: "server-loader/action",
    sourceFile: "bounded-contexts/platform-operations/features/projection-operations/api/client.ts",
    apiPath: "/api/platform/projections",
    sourceEvidence: ["/api/platform/projections"],
    contract: "internal-origin server call",
    localProxyPrefix: "/api/platform",
    smokeCoverageId: "SMOKE-API-PLATFORM-PROJECTIONS",
    topologyExpectations: {
      staging: "internal-origin or authenticated API data",
      "public-marketplace": "internal-origin",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-PUBLIC-PRESENCE-WAITLIST-EXPORT",
    section: "Growth",
    surface: "Public Presence Waitlist Export",
    callerType: "direct-download",
    sourceFile: "bounded-contexts/public-presence/routes/admin/waitlist.tsx",
    apiPath: "/api/public-presence/admin/waitlist/export",
    sourceEvidence: ["/api/public-presence/admin/waitlist/export"],
    contract: "admin public ingress",
    localProxyPrefix: "/api/public-presence",
    smokeCoverageId: "SMOKE-API-WAITLIST-EXPORT",
    topologyExpectations: {
      staging: "download returns CSV or authorization response",
      "public-marketplace": "admin public ingress",
      "production-platform-disabled": "admin public ingress",
    },
  },
  {
    id: "API-CATALOG-REALTIME-ACCOUNT-EVENTS",
    section: "Catalog",
    surface: "Catalog Realtime Account Events",
    callerType: "event-source",
    sourceFile: "infrastructure/platform-runtime/realtime-web.ts",
    apiPath: "/api/realtime/account/events",
    sourceEvidence: ["/api/realtime/account/events", "EventSource"],
    contract: "admin public ingress",
    localProxyPrefix: "/api/realtime",
    smokeCoverageId: "SMOKE-API-CATALOG-REALTIME",
    topologyExpectations: {
      staging: "SSE opens or returns controlled authorization response",
      "public-marketplace": "admin public ingress",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-CATALOG-SOURCE-OBS-INTEGRATION-JOB-EVENTS",
    section: "Catalog",
    surface: "Catalog Source Observation Integration Job Events",
    callerType: "durable-job-event-source",
    sourceFile: "bounded-contexts/catalog/support/shell-support/api/client.ts",
    apiPath: "/api/catalog/source-observations/integration-jobs/:jobId/events",
    sourceEvidence: ["/source-observations/integration-jobs/", "/events"],
    contract: "admin public ingress",
    localProxyPrefix: "/api/catalog",
    smokeCoverageId: "SMOKE-API-CATALOG-INTEGRATION-JOB-STREAM",
    topologyExpectations: {
      staging: "SSE opens or returns controlled authorization/not-found response",
      "public-marketplace": "admin public ingress",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-CATALOG-SOURCE-OBS-BULK-JOB-EVENTS",
    section: "Catalog",
    surface: "Catalog Source Observation Bulk Job Events",
    callerType: "durable-job-event-source",
    sourceFile: "bounded-contexts/catalog/support/shell-support/api/client.ts",
    apiPath: "/api/catalog/source-observations/bulk-jobs/:jobId/events",
    sourceEvidence: ["/source-observations/bulk-jobs/", "/events"],
    contract: "admin public ingress",
    localProxyPrefix: "/api/catalog",
    smokeCoverageId: "SMOKE-API-CATALOG-BULK-JOB-STREAM",
    topologyExpectations: {
      staging: "SSE opens or returns controlled authorization/not-found response",
      "public-marketplace": "admin public ingress",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
  {
    id: "API-CATALOG-AUTHORING-BULK-JOB-EVENTS",
    section: "Catalog",
    surface: "Catalog Authoring Bulk Job Events",
    callerType: "durable-job-event-source",
    sourceFile: "bounded-contexts/catalog/support/shell-support/api/client.ts",
    apiPath: "/api/catalog/bulk-authoring-jobs/:jobId/events",
    sourceEvidence: ["/bulk-authoring-jobs/", "/events"],
    contract: "admin public ingress",
    localProxyPrefix: "/api/catalog",
    smokeCoverageId: "SMOKE-API-CATALOG-AUTHORING-JOB-STREAM",
    topologyExpectations: {
      staging: "SSE opens or returns controlled authorization/not-found response",
      "public-marketplace": "admin public ingress",
      "production-platform-disabled": "controlled-unavailable or valid internal origin",
    },
  },
];

export const ADMIN_SHELL_SMOKE_MATRIX = [
  ...ADMIN_SHELL_SECTIONS.map((section) => ({
    id: `SMOKE-SHELL-${section.toUpperCase()}`,
    kind: "section-shell",
    section,
    route: `/${section.toLowerCase()}`,
    actor: "all-admin-permissions",
    assertions: ["shared top app bar", "account/sign-out access", "local navigation", "no Verified chip"],
    evidence: "browser or deployed Playwright smoke",
  })),
  ...ADMIN_PARTIAL_ACTORS.map((actor) => ({
    id: actor.id,
    kind: "partial-actor",
    section: actor.expectedSections.join("+"),
    route: actor.expectedEntryPaths.join(", "),
    actor: actor.permission,
    assertions: ["direct route entry", "section root resolution", "no misleading cross-section links"],
    evidence: "browser smoke or targeted auth/layout release evidence",
  })),
  {
    id: "SMOKE-LINK-PROMO-BAR-PUBLIC-HREF",
    kind: "content-managed-link",
    section: "Growth",
    route: "/growth/promo-bar",
    actor: "public-presence.view",
    assertions: ["public relative hrefs resolve to marketplace origin or render inert when origin is unavailable"],
    evidence: "browser smoke or guarded preview rendering test",
  },
  {
    id: "SMOKE-LINK-CROSS-SECTION-PERMISSION-AWARE",
    kind: "cross-section-link",
    section: "Growth+Platform",
    route: "/growth/google-shopping, /platform/projections",
    actor: "least-privilege section actor",
    assertions: ["same-host cross-section shortcuts render only with target permission"],
    evidence: "browser smoke or guardrail command output",
  },
  ...ADMIN_WEB_API_DEPENDENCIES.map((dependency) => ({
    id: dependency.smokeCoverageId,
    kind: "api-topology",
    section: dependency.section,
    route: dependency.apiPath,
    actor: "authorized admin or unauthenticated topology probe",
    assertions: [dependency.contract, dependency.callerType, dependency.id],
    evidence: "deployed smoke, topology inventory output, or controlled-unavailable release evidence",
  })),
];

export const ADMIN_DEPLOYED_PAGE_SMOKE_ROWS = [
  {
    id: "SMOKE-PAGE-ACCESS-USERS",
    path: "/access/users",
    section: "Access",
    expectedText: ["Access", "Users"],
    coverageIds: ["SMOKE-SHELL-ACCESS", "SMOKE-API-IDENTITY-ACCESS-ADMIN"],
  },
  {
    id: "SMOKE-PAGE-ACCESS-SESSIONS",
    path: "/access/sessions",
    section: "Access",
    expectedText: ["Access", "Sessions"],
    coverageIds: ["SMOKE-SHELL-ACCESS", "SMOKE-API-AUTH-ACCESS-SESSIONS"],
  },
  {
    id: "SMOKE-PAGE-CATALOG-ITEMS",
    path: "/catalog/catalog-items",
    section: "Catalog",
    expectedText: ["Catalog", "Catalog Items"],
    coverageIds: ["SMOKE-SHELL-CATALOG", "SMOKE-API-CATALOG-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PAGE-COMMERCE-TERMS-SCHEDULES",
    path: "/commerce/terms/schedules",
    section: "Commerce",
    expectedText: ["Commerce", "Commercial Terms", "Active and scheduled terms"],
    coverageIds: ["SMOKE-SHELL-COMMERCE", "SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PAGE-COMMERCE-TERMS-AGREEMENTS",
    path: "/commerce/terms/agreements",
    section: "Commerce",
    expectedText: ["Commerce", "Commercial Terms", "Active and scheduled terms"],
    coverageIds: ["SMOKE-SHELL-COMMERCE", "SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PAGE-COMMERCE-POSTAGE-POLICIES",
    path: "/commerce/postage-policies",
    section: "Commerce",
    expectedText: ["Commerce", "Postage Policies"],
    coverageIds: ["SMOKE-SHELL-COMMERCE", ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID],
  },
  {
    id: "SMOKE-PAGE-GROWTH-GOOGLE-SHOPPING",
    path: "/growth/google-shopping",
    section: "Growth",
    expectedText: ["Growth", "Google Shopping"],
    coverageIds: ["SMOKE-SHELL-GROWTH", "SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING"],
  },
  {
    id: "SMOKE-PAGE-GROWTH-WAITLIST",
    path: "/growth/waitlist",
    section: "Growth",
    expectedText: ["Growth", "Waitlist"],
    coverageIds: ["SMOKE-SHELL-GROWTH", "SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PAGE-GROWTH-PROMO-BAR",
    path: "/growth/promo-bar",
    section: "Growth",
    expectedText: ["Growth", "Promo Bar"],
    coverageIds: ["SMOKE-SHELL-GROWTH", "SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PAGE-SUPPORT-REQUESTS",
    path: "/support/requests",
    section: "Support",
    expectedText: ["Support"],
    coverageIds: ["SMOKE-SHELL-SUPPORT", "SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS"],
  },
  {
    id: "SMOKE-PAGE-SUPPORT-PLATFORM-FEEDBACK",
    path: "/support/platform-feedback",
    section: "Support",
    expectedText: ["Support", "Platform Feedback"],
    coverageIds: ["SMOKE-SHELL-SUPPORT", "SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK"],
  },
  {
    id: "SMOKE-PAGE-PLATFORM-PROJECTIONS",
    path: "/platform/projections",
    section: "Platform",
    expectedText: ["Platform", "Projection Operations"],
    coverageIds: ["SMOKE-SHELL-PLATFORM", "SMOKE-API-PLATFORM-PROJECTIONS"],
  },
];

export const ADMIN_DEPLOYED_API_SMOKE_PROBES = [
  {
    id: "SMOKE-PROBE-AUTH-SESSION",
    path: "/api/auth/session",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-AUTH-ACCESS-SESSIONS"],
  },
  {
    id: "SMOKE-PROBE-IDENTITY-CURRENT-ACTOR",
    path: "/api/identity/current-actor-display",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-IDENTITY-ACCESS-ADMIN"],
  },
  {
    id: "SMOKE-PROBE-CATALOG-PROVIDER-PROFILES",
    path: "/api/catalog/source-observations/provider-profiles",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-CATALOG-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PROBE-COMMERCIAL-TERMS-SCHEDULES",
    path: "/api/commercial-terms/schedules?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PROBE-MARKETPLACE-POSTAGE-POLICIES",
    path: "/api/marketplace/admin/postage-policies?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: [ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID],
  },
  {
    id: "SMOKE-PROBE-MARKETPLACE-GOOGLE-SHOPPING",
    path: "/api/marketplace/google-shopping/feed-rows?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING"],
  },
  {
    id: "SMOKE-PROBE-PUBLIC-PRESENCE-WAITLIST",
    path: "/api/public-presence/admin/waitlist?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER"],
  },
  {
    id: "SMOKE-PROBE-MARKETPLACE-SUPPORT-REQUESTS",
    path: "/api/marketplace/support-requests/ops?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS"],
  },
  {
    id: "SMOKE-PROBE-EXPERIENCE-PLATFORM-FEEDBACK",
    path: "/api/experience/platform-feedback?limit=1&offset=0",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK"],
  },
  {
    id: "SMOKE-PROBE-PLATFORM-PROJECTIONS",
    path: "/api/platform/projections",
    method: "GET",
    accept: "application/json",
    expectedStatuses: [200, 401, 403, 503],
    expectedContentTypes: ["application/json"],
    coverageIds: ["SMOKE-API-PLATFORM-PROJECTIONS"],
  },
  {
    id: "SMOKE-PROBE-WAITLIST-EXPORT",
    path: "/api/public-presence/admin/waitlist/export",
    method: "GET",
    accept: "text/csv, application/json",
    expectedStatuses: [200, 401, 403],
    expectedContentTypes: ["text/csv", "application/json"],
    coverageIds: ["SMOKE-API-WAITLIST-EXPORT"],
  },
  {
    id: "SMOKE-PROBE-CATALOG-REALTIME",
    path: "/api/realtime/account/events?topic=account%3Atopology-smoke%3Alistings",
    method: "GET",
    accept: "text/event-stream, application/json",
    expectedStatuses: [200, 401, 403],
    expectedContentTypes: ["text/event-stream", "application/json"],
    coverageIds: ["SMOKE-API-CATALOG-REALTIME"],
  },
  {
    id: "SMOKE-PROBE-CATALOG-INTEGRATION-JOB-STREAM",
    path: "/api/catalog/source-observations/integration-jobs/topology-smoke/events",
    method: "GET",
    accept: "text/event-stream, application/json",
    expectedStatuses: [200, 401, 403, 404],
    expectedContentTypes: ["text/event-stream", "application/json"],
    coverageIds: ["SMOKE-API-CATALOG-INTEGRATION-JOB-STREAM"],
  },
  {
    id: "SMOKE-PROBE-CATALOG-BULK-JOB-STREAM",
    path: "/api/catalog/source-observations/bulk-jobs/topology-smoke/events",
    method: "GET",
    accept: "text/event-stream, application/json",
    expectedStatuses: [200, 401, 403, 404],
    expectedContentTypes: ["text/event-stream", "application/json"],
    coverageIds: ["SMOKE-API-CATALOG-BULK-JOB-STREAM"],
  },
  {
    id: "SMOKE-PROBE-CATALOG-AUTHORING-JOB-STREAM",
    path: "/api/catalog/bulk-authoring-jobs/topology-smoke/events",
    method: "GET",
    accept: "text/event-stream, application/json",
    expectedStatuses: [200, 401, 403, 404],
    expectedContentTypes: ["text/event-stream", "application/json"],
    coverageIds: ["SMOKE-API-CATALOG-AUTHORING-JOB-STREAM"],
  },
];

function requiresFulfillmentPostage(row) {
  return row.coverageIds.includes(ADMIN_FULFILLMENT_POSTAGE_SMOKE_COVERAGE_ID);
}

function apiDependencyForCoverageId(coverageId) {
  return ADMIN_WEB_API_DEPENDENCIES.find((dependency) => dependency.smokeCoverageId === coverageId);
}

function isMandatoryProductionPlatformDisabledProbe(probe) {
  return probe.coverageIds.includes("SMOKE-API-PLATFORM-PROJECTIONS");
}

function supportsDeployedApiProbeForTopology(probe, topologyMode) {
  if (topologyMode !== "production-platform-disabled") {
    return true;
  }

  if (isMandatoryProductionPlatformDisabledProbe(probe)) {
    return true;
  }

  return probe.coverageIds.some((coverageId) => {
    const expectation = apiDependencyForCoverageId(coverageId)?.topologyExpectations?.[topologyMode] ?? "";
    return expectation.includes("platform-api landing route") || expectation.includes("admin public ingress");
  });
}

export function selectAdminDeployedPageSmokeRows(options = {}) {
  const { requireFulfillmentPostage = true } = options;
  return ADMIN_DEPLOYED_PAGE_SMOKE_ROWS.filter((row) => requireFulfillmentPostage || !requiresFulfillmentPostage(row));
}

export function selectAdminDeployedApiSmokeProbes(options = {}) {
  const { requireFulfillmentPostage = true, topologyMode = "staging" } = options;
  return ADMIN_DEPLOYED_API_SMOKE_PROBES.filter(
    (probe) =>
      (requireFulfillmentPostage || !requiresFulfillmentPostage(probe)) &&
      supportsDeployedApiProbeForTopology(probe, topologyMode),
  );
}
