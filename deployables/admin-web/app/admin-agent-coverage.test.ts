import type { BcAgentCoverageExemptionCode } from "@chase-sets/bounded-context-module";
import { findMcpTool, flattenMcpTools, isAvailableMcpCapability } from "@chase-sets/platform-runtime/mcp-contracts";
import type { WebContextRegistry } from "@chase-sets/platform-runtime/web";
import {
  resolveWebHostRouteConfigRecords,
  type HostRouteConfigRecord,
} from "@chase-sets/platform-runtime/web-route-config";
import { describe, expect, it } from "vitest";
import { webContextRegistry } from "./context-registry";
import { resolveAdminWebRouteConfigRecords } from "./host";

// Exhaustive over the contract's closed union: adding or removing a code there is a typecheck error here.
const EXEMPTION_CODES = {
  "sign-in-flow": true,
  "navigation-only": true,
  "human-presence-required": true,
  "file-upload": true,
} as const satisfies Record<BcAgentCoverageExemptionCode, true>;

type CoverageKind = "tools" | "exempt" | "pending";
type CoveredRoute = Readonly<{ section: string; kind: CoverageKind }>;
type CoverageAudit = Readonly<{ violations: readonly string[]; covered: readonly CoveredRoute[] }>;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function toolProblems(tools: unknown, requireOne: boolean): string[] {
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    return ["tools must be an array of tool names"];
  }
  if (requireOne && tools.length === 0) {
    return ["tools must name at least one MCP tool"];
  }
  return (tools as string[]).flatMap((name) => {
    const tool = findMcpTool(name);
    if (!tool) return [`tool '${name}' is not in mcpServiceCatalog`];
    return isAvailableMcpCapability(tool) ? [] : [`tool '${name}' is planned, not available`];
  });
}

function classifyDeclaration(declaration: unknown): Readonly<{ kind?: CoverageKind; problems: string[] }> {
  if (!isRecord(declaration)) {
    return { problems: ["declaration must be an object"] };
  }
  if (hasExactKeys(declaration, ["tools"])) {
    return { kind: "tools", problems: toolProblems(declaration.tools, true) };
  }
  if (hasExactKeys(declaration, ["exempt", "note", "tools"])) {
    const { exempt, note } = declaration;
    const problems = [
      ...(typeof exempt === "string" && Object.hasOwn(EXEMPTION_CODES, exempt)
        ? []
        : [`exemption code '${String(exempt)}' is not one of ${Object.keys(EXEMPTION_CODES).join(", ")}`]),
      ...(typeof note === "string" && note.trim().length > 0 ? [] : ["note must explain the exemption"]),
      ...toolProblems(declaration.tools, false),
    ];
    return { kind: "exempt", problems };
  }
  if (hasExactKeys(declaration, ["pending"])) {
    const { pending } = declaration;
    return {
      kind: "pending",
      problems:
        typeof pending === "string" && /^#[1-9]\d*$/.test(pending) ? [] : ["pending must reference an issue as #N"],
    };
  }
  return {
    problems: [
      `declaration must be exactly one of { tools }, { exempt, note, tools } or { pending }; got keys [${Object.keys(declaration).join(", ")}]`,
    ],
  };
}

// Joins admin-web route records with each source context's raw agentCoverage. Route ownership and the
// route surface come only from the resolved records, never from route paths or file names.
function auditAgentCoverage(registry: WebContextRegistry, routes: readonly HostRouteConfigRecord[]): CoverageAudit {
  const violations: string[] = [];
  const covered: CoveredRoute[] = [];
  const routesByContext = new Map<string, Map<string, HostRouteConfigRecord[]>>();

  for (const route of routes) {
    const ownRoutes = routesByContext.get(route.sourceContext) ?? new Map<string, HostRouteConfigRecord[]>();
    ownRoutes.set(route.routeId, [...(ownRoutes.get(route.routeId) ?? []), route]);
    routesByContext.set(route.sourceContext, ownRoutes);
  }

  for (const [contextName, ownRoutes] of routesByContext) {
    if (!registry.some((entry) => entry.contextName === contextName)) {
      for (const routeId of ownRoutes.keys()) {
        violations.push(`${contextName}/${routeId}: source context has no manifest in the admin-web registry`);
      }
    }
  }

  for (const entry of registry) {
    const { contextName } = entry;
    const ownRoutes = routesByContext.get(contextName) ?? new Map<string, HostRouteConfigRecord[]>();
    const coverage = (entry.manifest as Readonly<{ agentCoverage?: unknown }>).agentCoverage;
    if (coverage !== undefined && !isRecord(coverage)) {
      violations.push(`${contextName}: agentCoverage must be an object keyed by admin-web routeId`);
    }
    const declarations = isRecord(coverage) ? coverage : {};

    for (const [routeId, records] of ownRoutes) {
      const label = `${contextName}/${routeId}`;
      if (records.length > 1) {
        violations.push(`${label}: routeId names ${records.length} admin-web routes; each route needs its own routeId`);
      }
      if (!Object.hasOwn(declarations, routeId)) {
        violations.push(`${label}: admin-web route has no agentCoverage entry`);
        continue;
      }
      const { kind, problems } = classifyDeclaration(declarations[routeId]);
      violations.push(...problems.map((problem) => `${label}: ${problem}`));
      if (kind && problems.length === 0) {
        covered.push(...records.map((record) => ({ section: record.section ?? "unsectioned", kind })));
      }
    }

    for (const routeId of Object.keys(declarations)) {
      if (!ownRoutes.has(routeId)) {
        violations.push(`${contextName}/${routeId}: agentCoverage entry names no admin-web route of this context`);
      }
    }
  }

  return { violations, covered };
}

function formatCoverageSummary(covered: readonly CoveredRoute[]) {
  const count = (routes: readonly CoveredRoute[], kind: CoverageKind) =>
    routes.filter((route) => route.kind === kind).length;
  const line = (label: string, routes: readonly CoveredRoute[]) =>
    `${label}: ${routes.length} routes (tools ${count(routes, "tools")}, exempt ${count(routes, "exempt")}, pending ${count(routes, "pending")})`;
  const sections = [...new Set(covered.map((route) => route.section))];

  return [
    line("Agent Coverage admin-web", covered),
    ...sections.map((section) =>
      line(
        `  ${section}`,
        covered.filter((route) => route.section === section),
      ),
    ),
  ].join("\n");
}

const adminRoutes = resolveAdminWebRouteConfigRecords();

function cloneRegistry(): WebContextRegistry {
  return structuredClone(webContextRegistry);
}

function auditRegistry(registry: WebContextRegistry) {
  return auditAgentCoverage(registry, resolveWebHostRouteConfigRecords(registry, "admin-web"));
}

function manifestOf(registry: WebContextRegistry, contextName: string) {
  const entry = registry.find((candidate) => candidate.contextName === contextName);
  if (!entry) throw new Error(`No registry entry for ${contextName}`);
  return entry.manifest as { agentCoverage?: unknown };
}

function coverageOf(registry: WebContextRegistry, contextName: string): UnknownRecord {
  const coverage = manifestOf(registry, contextName).agentCoverage;
  if (!isRecord(coverage)) throw new Error(`${contextName} has no agentCoverage object to mutate`);
  return coverage;
}

function adminContributionsOf(registry: WebContextRegistry, contextName: string) {
  const manifest = manifestOf(registry, contextName) as {
    deployableContributions?: { deployable: string; routes: UnknownRecord[] }[];
  };
  return (manifest.deployableContributions ?? []).filter((contribution) => contribution.deployable === "admin-web");
}

function adminRouteDeclarationOf(registry: WebContextRegistry, contextName: string, routeId: string) {
  const declaration = adminContributionsOf(registry, contextName)
    .flatMap((contribution) => contribution.routes)
    .find((route) => route.routeId === routeId);
  if (!declaration) throw new Error(`${contextName} declares no admin-web route ${routeId}`);
  return declaration;
}

function routeIdsOf(contextName: string) {
  return adminRoutes.filter((route) => route.sourceContext === contextName).map((route) => route.routeId);
}

const [targetRoute] = adminRoutes;

function auditWithTargetDeclaration(declaration: unknown) {
  const registry = cloneRegistry();
  coverageOf(registry, targetRoute!.sourceContext)[targetRoute!.routeId] = declaration;
  return auditRegistry(registry).violations;
}

const targetLabel = () => `${targetRoute!.sourceContext}/${targetRoute!.routeId}`;

describe("admin-web Agent Coverage", () => {
  it("declares tools, an exemption or a pending issue for every admin-web route record", () => {
    expect(adminRoutes.length).toBeGreaterThan(0);

    const audit = auditAgentCoverage(webContextRegistry, adminRoutes);
    console.info(formatCoverageSummary(audit.covered));

    expect(audit.violations).toEqual([]);
    expect(audit.covered).toHaveLength(adminRoutes.length);
  });

  it("fails naming the context and routeId when any single route's entry is removed", () => {
    for (const route of adminRoutes) {
      const registry = cloneRegistry();
      delete coverageOf(registry, route.sourceContext)[route.routeId];

      expect(auditRegistry(registry).violations).toEqual([
        `${route.sourceContext}/${route.routeId}: admin-web route has no agentCoverage entry`,
      ]);
    }
  });

  it("fails for each route of a contributing context whose agentCoverage is empty, absent or not an object", () => {
    const contributingContexts = [...new Set(adminRoutes.map((route) => route.sourceContext))];
    const variants: readonly Readonly<{ name: string; apply: (manifest: { agentCoverage?: unknown }) => void }>[] = [
      { name: "empty", apply: (manifest) => (manifest.agentCoverage = {}) },
      { name: "absent", apply: (manifest) => delete manifest.agentCoverage },
      { name: "array", apply: (manifest) => (manifest.agentCoverage = []) },
    ];

    for (const contextName of contributingContexts) {
      const missing = routeIdsOf(contextName).map(
        (routeId) => `${contextName}/${routeId}: admin-web route has no agentCoverage entry`,
      );
      for (const variant of variants) {
        const registry = cloneRegistry();
        variant.apply(manifestOf(registry, contextName));

        expect(auditRegistry(registry).violations, `${contextName} ${variant.name}`).toEqual(
          variant.name === "array"
            ? [`${contextName}: agentCoverage must be an object keyed by admin-web routeId`, ...missing]
            : missing,
        );
      }
    }
  });

  it("fails an entry whose routeId is not one of its own context's admin-web routes", () => {
    const owner = targetRoute!.sourceContext;
    const foreignRoute = adminRoutes.find(
      (route) => route.sourceContext !== owner && !routeIdsOf(owner).includes(route.routeId),
    );
    expect(foreignRoute).toBeDefined();

    for (const routeId of ["not-an-admin-route", foreignRoute!.routeId]) {
      const registry = cloneRegistry();
      coverageOf(registry, owner)[routeId] = { pending: "#9238" };

      expect(auditRegistry(registry).violations).toEqual([
        `${owner}/${routeId}: agentCoverage entry names no admin-web route of this context`,
      ]);
    }
  });

  it("reads each route's coverage from its sourceContext manifest", () => {
    const owner = targetRoute!.sourceContext;
    const routeId = targetRoute!.routeId;
    const otherContext = adminRoutes.find(
      (route) => route.sourceContext !== owner && !routeIdsOf(route.sourceContext).includes(routeId),
    )?.sourceContext;
    expect(otherContext).toBeDefined();
    const staleEntry = `${owner}/${routeId}: agentCoverage entry names no admin-web route of this context`;

    for (const [sourceContext, expected] of [
      [otherContext!, `${otherContext}/${routeId}: admin-web route has no agentCoverage entry`],
      [
        "unregistered-context",
        `unregistered-context/${routeId}: source context has no manifest in the admin-web registry`,
      ],
    ] as const) {
      const registry = cloneRegistry();
      adminRouteDeclarationOf(registry, owner, routeId).sourceContext = sourceContext;

      expect([...auditRegistry(registry).violations].sort()).toEqual([expected, staleEntry].sort());
    }
  });

  it("fails a routeId shared by two admin-web routes of one context", () => {
    const registry = cloneRegistry();
    const declaration = adminRouteDeclarationOf(registry, targetRoute!.sourceContext, targetRoute!.routeId);
    adminContributionsOf(registry, targetRoute!.sourceContext)[0]!.routes.push({
      ...declaration,
      routePath: `${String(declaration.routePath)}-duplicate`,
    });

    expect(auditRegistry(registry).violations).toEqual([
      `${targetLabel()}: routeId names 2 admin-web routes; each route needs its own routeId`,
    ]);
  });

  it("fails a named tool that is missing from mcpServiceCatalog", () => {
    expect(auditWithTargetDeclaration({ tools: ["platform-operations.not-a-tool"] })).toEqual([
      `${targetLabel()}: tool 'platform-operations.not-a-tool' is not in mcpServiceCatalog`,
    ]);
  });

  it("fails a named tool that is planned rather than available", () => {
    const plannedTool = flattenMcpTools().find((tool) => !isAvailableMcpCapability(tool));
    expect(plannedTool).toBeDefined();
    const expected = [`${targetLabel()}: tool '${plannedTool!.name}' is planned, not available`];

    expect(auditWithTargetDeclaration({ tools: [plannedTool!.name] })).toEqual(expected);
    expect(
      auditWithTargetDeclaration({ exempt: "human-presence-required", note: "Synthetic.", tools: [plannedTool!.name] }),
    ).toEqual(expected);
  });

  it("fails an exemption code outside the closed set", () => {
    expect(auditWithTargetDeclaration({ exempt: "operator-preference", note: "Synthetic.", tools: [] })).toEqual([
      `${targetLabel()}: exemption code 'operator-preference' is not one of sign-in-flow, navigation-only, human-presence-required, file-upload`,
    ]);
  });

  it.each([
    ["null", null, "declaration must be an object"],
    ["a string", "#9238", "declaration must be an object"],
    ["an array", [], "declaration must be an object"],
    [
      "no keys",
      {},
      "declaration must be exactly one of { tools }, { exempt, note, tools } or { pending }; got keys []",
    ],
    [
      "pending mixed with tools",
      { pending: "#9238", tools: ["platform-operations.get-offer-economics-summary"] },
      "declaration must be exactly one of { tools }, { exempt, note, tools } or { pending }; got keys [pending, tools]",
    ],
    [
      "an exemption without a note",
      { exempt: "sign-in-flow", tools: [] },
      "declaration must be exactly one of { tools }, { exempt, note, tools } or { pending }; got keys [exempt, tools]",
    ],
    ["an empty tools list", { tools: [] }, "tools must name at least one MCP tool"],
    [
      "tools that is not a list of names",
      { tools: "platform-operations.get-offer-economics-summary" },
      "tools must be an array of tool names",
    ],
    ["a blank exemption note", { exempt: "sign-in-flow", note: " ", tools: [] }, "note must explain the exemption"],
    ["a pending value that is not an issue reference", { pending: "9238" }, "pending must reference an issue as #N"],
  ])("fails a malformed declaration: %s", (_name, declaration, message) => {
    expect(auditWithTargetDeclaration(declaration)).toEqual([`${targetLabel()}: ${message}`]);
  });
});
