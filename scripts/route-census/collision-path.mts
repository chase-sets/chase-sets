import { fail } from "./errors.mts";
import type { TargetHonoUrlHelpers } from "./target-authority.mts";

export type AcceptedPathProjection = Readonly<{
  acceptedPath: string;
  collisionPath: string;
}>;

export type CollisionProjection = Readonly<{
  combinedPath: string;
  acceptedPathProjections: readonly AcceptedPathProjection[];
  collisionShape: readonly string[];
}>;

function collisionPathForAcceptedPath(acceptedPath: string, helpers: TargetHonoUrlHelpers): string {
  const segments = helpers.splitRoutingPath(acceptedPath);
  if (!Array.isArray(segments) || segments.some((segment) => typeof segment !== "string")) {
    fail("E_ROUTE_PATTERN", `Target splitRoutingPath returned an invalid result for '${acceptedPath}'.`);
  }
  let parameterPosition = 0;
  const collisionSegments = segments.map((segment, index) => {
    if (segment === "*") return segment;
    if (!segment.startsWith(":")) return segment;
    const pattern = helpers.getPattern(segment, segments[index + 1]);
    if (pattern === null || pattern === "*") {
      fail("E_ROUTE_PATTERN", `Target getPattern rejected '${segment}' in '${acceptedPath}'.`);
    }
    parameterPosition += 1;
    const braceStart = segment.indexOf("{");
    const exactPattern = braceStart === -1 ? "" : segment.slice(braceStart);
    return `:p${parameterPosition}${exactPattern}`;
  });
  return `/${collisionSegments.join("/")}`;
}

export function deriveCollisionProjection(
  mountPath: string,
  rawPath: string,
  helpers: TargetHonoUrlHelpers,
): CollisionProjection {
  if (typeof mountPath !== "string" || typeof rawPath !== "string") {
    fail("E_ROUTE_SHAPE", "Route mountPath and rawPath must be strings.");
  }
  const combinedPath = helpers.mergePath(mountPath, rawPath);
  if (typeof combinedPath !== "string") {
    fail("E_ROUTE_PATTERN", "Target mergePath returned a non-string result.");
  }
  const expanded = helpers.checkOptionalParameter(combinedPath);
  if (expanded !== null && (!Array.isArray(expanded) || expanded.some((value) => typeof value !== "string"))) {
    fail("E_ROUTE_PATTERN", `Target checkOptionalParameter returned an invalid result for '${combinedPath}'.`);
  }
  const acceptedPaths = expanded === null ? [combinedPath] : expanded;
  if (acceptedPaths.length === 0) {
    fail("E_ROUTE_PATTERN", `Target checkOptionalParameter returned an empty expansion for '${combinedPath}'.`);
  }
  const acceptedPathProjections = acceptedPaths.map((acceptedPath) => ({
    acceptedPath,
    collisionPath: collisionPathForAcceptedPath(acceptedPath, helpers),
  }));
  return {
    combinedPath,
    acceptedPathProjections,
    collisionShape: acceptedPathProjections.map(({ collisionPath }) => collisionPath),
  };
}

export const COLLISION_VECTOR_SCHEMA = "chase-sets-route-collision-vector/v1" as const;

const collisionFixtureVectorSeeds = {
  schemaVersion: COLLISION_VECTOR_SCHEMA,
  authority: {
    specifier: "hono/utils/url",
    helperLifecycle: ["mergePath", "checkOptionalParameter", "splitRoutingPath", "getPattern"],
    handledSegmentClasses: ["empty", "literal", "wildcard", "colon-parameter"],
    unknownDisposition: "indeterminate-error",
  },
  cases: [
    { id: "mount-root", mountPath: "/", rawPath: "/", combinedPath: "/", collisionShape: ["/"] },
    {
      id: "mounted-root-r0313",
      mountPath: "/api/customer-feedback",
      rawPath: "/",
      combinedPath: "/api/customer-feedback",
      collisionShape: ["/api/customer-feedback"],
    },
    {
      id: "ordinary-child",
      mountPath: "/api",
      rawPath: "/items/:id",
      combinedPath: "/api/items/:id",
      collisionShape: ["/api/items/:p1"],
    },
    {
      id: "trailing-slash",
      mountPath: "/api",
      rawPath: "/items/",
      combinedPath: "/api/items/",
      collisionShape: ["/api/items/"],
    },
    {
      id: "boundary-both-slashes",
      mountPath: "/api/",
      rawPath: "/items",
      combinedPath: "/api/items",
      collisionShape: ["/api/items"],
    },
    {
      id: "boundary-raw-no-slash",
      mountPath: "/api/",
      rawPath: "items",
      combinedPath: "/api/items",
      collisionShape: ["/api/items"],
    },
    {
      id: "terminal-optional-custom-id",
      mountPath: "/",
      rawPath: "/:id{foo}?",
      combinedPath: "/:id{foo}?",
      acceptedPaths: ["/", "/:id{foo}"],
      collisionShape: ["/", "/:p1{foo}"],
    },
    {
      id: "terminal-optional-custom-slug",
      mountPath: "/",
      rawPath: "/:slug{foo}?",
      combinedPath: "/:slug{foo}?",
      acceptedPaths: ["/", "/:slug{foo}"],
      collisionShape: ["/", "/:p1{foo}"],
    },
    {
      id: "nonterminal-question-name",
      mountPath: "/",
      rawPath: "/a/:id?/b",
      combinedPath: "/a/:id?/b",
      collisionShape: ["/a/:p1/b"],
    },
    {
      id: "nonterminal-question-peer",
      mountPath: "/",
      rawPath: "/a/:slug/b",
      combinedPath: "/a/:slug/b",
      collisionShape: ["/a/:p1/b"],
    },
    {
      id: "question-inside-name-custom",
      mountPath: "/",
      rawPath: "/:id?{foo}",
      combinedPath: "/:id?{foo}",
      collisionShape: ["/:p1{foo}"],
    },
    {
      id: "question-inside-name-peer",
      mountPath: "/",
      rawPath: "/:slug{foo}",
      combinedPath: "/:slug{foo}",
      collisionShape: ["/:p1{foo}"],
    },
    {
      id: "two-optionals",
      mountPath: "/",
      rawPath: "/:a?/:b?",
      combinedPath: "/:a?/:b?",
      acceptedPaths: ["/", "/:a", "/:a/:b"],
      collisionShape: ["/", "/:p1", "/:p1/:p2"],
    },
    {
      id: "two-optionals-peer",
      mountPath: "/",
      rawPath: "/:left?/:right?",
      combinedPath: "/:left?/:right?",
      acceptedPaths: ["/", "/:left", "/:left/:right"],
      collisionShape: ["/", "/:p1", "/:p1/:p2"],
    },
    {
      id: "one-optional",
      mountPath: "/",
      rawPath: "/:id?",
      combinedPath: "/:id?",
      acceptedPaths: ["/", "/:id"],
      collisionShape: ["/", "/:p1"],
    },
    {
      id: "required-peer",
      mountPath: "/",
      rawPath: "/:slug",
      combinedPath: "/:slug",
      collisionShape: ["/:p1"],
    },
    {
      id: "slash-pattern",
      mountPath: "/",
      rawPath: "/:id{foo/bar}",
      combinedPath: "/:id{foo/bar}",
      collisionShape: ["/:p1{foo/bar}"],
    },
    {
      id: "slash-pattern-before-optional",
      mountPath: "/",
      rawPath: "/:x{foo/bar}/:y?",
      combinedPath: "/:x{foo/bar}/:y?",
      acceptedPaths: ["/:x{foo/bar}", "/:x{foo/bar}/:y"],
      collisionShape: ["/:p1{foo/bar}", "/:p1{foo/bar}/:p2"],
    },
    {
      id: "surprising-terminal-optional-slash-pattern",
      mountPath: "/",
      rawPath: "/:a?/:b{foo/bar}?",
      combinedPath: "/:a?/:b{foo/bar}?",
      acceptedPaths: ["/", "/:a"],
      collisionShape: ["/", "/:p1"],
    },
    {
      id: "custom-digits",
      mountPath: "/",
      rawPath: "/:id{[0-9]+}",
      combinedPath: "/:id{[0-9]+}",
      collisionShape: ["/:p1{[0-9]+}"],
    },
    {
      id: "custom-letters",
      mountPath: "/",
      rawPath: "/:id{[a-z]+}",
      combinedPath: "/:id{[a-z]+}",
      collisionShape: ["/:p1{[a-z]+}"],
    },
    {
      id: "literal-colon",
      mountPath: "/",
      rawPath: "/value:part",
      combinedPath: "/value:part",
      collisionShape: ["/value:part"],
    },
    { id: "wildcard", mountPath: "/api", rawPath: "/*", combinedPath: "/api/*", collisionShape: ["/api/*"] },
    {
      id: "double-optional-target-lifecycle",
      mountPath: "/",
      rawPath: "/:id??",
      combinedPath: "/:id??",
      acceptedPaths: ["/", "/:id?"],
      collisionShape: ["/", "/:p1"],
    },
    { id: "empty-name", mountPath: "/", rawPath: "/:", error: "E_ROUTE_PATTERN" },
    { id: "empty-pattern", mountPath: "/", rawPath: "/:id{}", error: "E_ROUTE_PATTERN" },
    { id: "unclosed-pattern", mountPath: "/", rawPath: "/:id{foo", error: "E_ROUTE_PATTERN" },
    { id: "misplaced-optional", mountPath: "/", rawPath: "/:id{foo}?/tail", error: "E_ROUTE_PATTERN" },
    { id: "empty-optional-expansion", mountPath: "/", rawPath: "/:id{foo/bar}?", error: "E_ROUTE_PATTERN" },
  ],
  relations: [
    {
      id: "terminal-optional-custom-renaming",
      left: "terminal-optional-custom-id",
      right: "terminal-optional-custom-slug",
      result: "collide",
    },
    {
      id: "nonterminal-question-erased",
      left: "nonterminal-question-name",
      right: "nonterminal-question-peer",
      result: "collide",
    },
    {
      id: "question-name-custom-erased",
      left: "question-inside-name-custom",
      right: "question-inside-name-peer",
      result: "collide",
    },
    { id: "multiple-optional-renaming", left: "two-optionals", right: "two-optionals-peer", result: "collide" },
    { id: "optional-versus-required", left: "one-optional", right: "required-peer", result: "distinct" },
    { id: "different-custom-patterns", left: "custom-digits", right: "custom-letters", result: "distinct" },
  ],
} as const;

export const collisionFixtureVector = {
  ...collisionFixtureVectorSeeds,
  cases: collisionFixtureVectorSeeds.cases.map((seed) => {
    if ("error" in seed) return seed;
    const acceptedPaths = "acceptedPaths" in seed ? seed.acceptedPaths : [seed.combinedPath];
    const { acceptedPaths: _acceptedPaths, ...published } = seed as typeof seed & {
      acceptedPaths?: readonly string[];
    };
    return {
      ...published,
      acceptedPathProjections: seed.collisionShape.map((collisionPath, index) => ({
        acceptedPath: acceptedPaths[index],
        collisionPath,
      })),
    };
  }),
} as const;
