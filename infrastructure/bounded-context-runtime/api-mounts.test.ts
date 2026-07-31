import { createHash } from "node:crypto";
import { every } from "hono/combine";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  ApiMountBindingError,
  ApiRouteTableCensusError,
  assertApiRouteTableHasNoCollisions,
  createResolvedApiMount,
  deriveApiRouteCollisionProjection,
  resolveContextApiMounts,
} from "./api-mounts";

const sharedCollisionVectorModule = new URL("../../scripts/route-census/collision-path.mts", import.meta.url).href;

type SharedCollisionVector = Readonly<{
  schemaVersion: string;
  cases: readonly (
    | Readonly<{
        id: string;
        mountPath: string;
        rawPath: string;
        error: "E_ROUTE_PATTERN";
      }>
    | Readonly<{
        id: string;
        mountPath: string;
        rawPath: string;
        combinedPath: string;
        acceptedPathProjections: readonly Readonly<{ acceptedPath: string; collisionPath: string }>[];
        collisionShape: readonly string[];
      }>
  )[];
  relations: readonly Readonly<{
    id: string;
    left: string;
    right: string;
    result: "collide" | "distinct";
  }>[];
}>;

const mount = (mountPath: string) => ({ mountPath, kind: "primary", requiresAuth: true });
const entry = <TRouter>(mountPath: string, contextMountOrdinal: number, router: TRouter) => ({
  mountPath,
  contextMountOrdinal,
  router,
});
const resolvedMount = <TRouter>(contextName: string, mountPath: string, contextMountOrdinal: number, router: TRouter) =>
  createResolvedApiMount(contextName, mount(mountPath), router, contextMountOrdinal);

const terminal = (label: string) => (context: { text(value: string): Response }) => context.text(label);
const middleware = () => async (_context: unknown, next: () => Promise<void>) => next();

function expectCollision(mounts: Parameters<typeof assertApiRouteTableHasNoCollisions>[0]) {
  try {
    assertApiRouteTableHasNoCollisions(mounts);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRouteTableCensusError);
    expect(error).toMatchObject({ code: "E_ROUTE_COLLISION" });
    return error;
  }
  throw new Error("Expected the route-table census to reject a collision.");
}

describe("API mount binding", () => {
  it("rejects a mountPath mismatch with the context, position, and both paths", () => {
    expect(() =>
      resolveContextApiMounts("platform-operations", [mount("/api/platform")], [entry("/api/marketplace", 1, {})]),
    ).toThrowError(
      expect.objectContaining({
        name: "ApiMountBindingError",
        details: {
          contextName: "platform-operations",
          position: 1,
          declaredMountPath: "/api/platform",
          providedMountPath: "/api/marketplace",
        },
      }),
    );
  });

  it("rejects an ordinal mismatch with the context, position, and both ordinals", () => {
    expect(() =>
      resolveContextApiMounts("marketplace", [mount("/api/marketplace")], [entry("/api/marketplace", 3, {})]),
    ).toThrowError(
      expect.objectContaining({
        name: "ApiMountBindingError",
        details: {
          contextName: "marketplace",
          position: 1,
          expectedContextMountOrdinal: 1,
          providedContextMountOrdinal: 3,
        },
      }),
    );
  });

  it("rejects a count mismatch", () => {
    expect(() => resolveContextApiMounts("catalog", [mount("/api/catalog")], [])).toThrowError(
      expect.objectContaining({
        name: "ApiMountBindingError",
        details: {
          contextName: "catalog",
          declaredMountCount: 1,
          providedEntryCount: 0,
        },
      }),
    );
  });

  it("rejects a complete same-path entry swap by ordinal", () => {
    const entries = [
      entry("/api/marketplace", 1, {}),
      entry("/api/marketplace", 2, {}),
      entry("/api/marketplace", 3, {}),
    ];

    expect(() =>
      resolveContextApiMounts(
        "marketplace",
        [mount("/api/marketplace"), mount("/api/marketplace"), mount("/api/marketplace")],
        [entries[2], entries[1], entries[0]],
      ),
    ).toThrowError(ApiMountBindingError);
  });

  it("rejects a cross-path entry swap by mountPath", () => {
    const entries = [entry("/api/platform", 1, {}), entry("/api/experience", 2, {}), entry("/api/marketplace", 3, {})];

    expect(() =>
      resolveContextApiMounts(
        "platform-operations",
        [mount("/api/platform"), mount("/api/experience"), mount("/api/marketplace")],
        [entries[0], entries[2], entries[1]],
      ),
    ).toThrowError(
      expect.objectContaining({
        details: expect.objectContaining({ position: 2, declaredMountPath: "/api/experience" }),
      }),
    );
  });

  it("preserves three same-path routers slot by slot without sorting or deduplication", () => {
    const routers = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const resolved = resolveContextApiMounts(
      "marketplace",
      [mount("/api/marketplace"), mount("/api/marketplace"), mount("/api/marketplace")],
      routers.map((router, index) => entry("/api/marketplace", index + 1, router)),
    );

    expect(resolved).toHaveLength(3);
    expect(resolved.map(({ router }) => router)).toEqual(routers);
    resolved.forEach((item, index) => expect(item.router).toBe(routers[index]));
  });

  it("keeps the unwrapped inner router on ResolvedApiMount", () => {
    const router = new Hono();
    const [resolved] = resolveContextApiMounts("catalog", [mount("/api/catalog")], [entry("/api/catalog", 1, router)]);

    expect(resolved.router).toBe(router);
  });

  it("allows literal-preserving router swaps so the ordered parity fingerprint remains the backstop", () => {
    const first = new Hono().get("/first", terminal("first"));
    const third = new Hono().get("/third", terminal("third"));
    const resolved = resolveContextApiMounts(
      "marketplace",
      [mount("/api/marketplace"), mount("/api/marketplace"), mount("/api/marketplace")],
      [
        entry("/api/marketplace", 1, third),
        entry("/api/marketplace", 2, new Hono().get("/middle", terminal("middle"))),
        entry("/api/marketplace", 3, first),
      ],
    );

    const orderedPaths = resolved.flatMap(({ router }, index) => router.routes.map((route) => [index + 1, route.path]));
    expect(orderedPaths).toEqual([
      [1, "/third"],
      [2, "/middle"],
      [3, "/first"],
    ]);
  });
});

describe("API route collision projection", () => {
  it("deep-compares every result with the immutable target-derived shared vector", async () => {
    const vectorModule: Readonly<{ collisionFixtureVector: SharedCollisionVector }> = await import(
      sharedCollisionVectorModule
    );
    const { collisionFixtureVector } = vectorModule;
    const vectorIdentity = createHash("sha256").update(JSON.stringify(collisionFixtureVector)).digest("hex");
    console.info(
      `route-collision-vector schema=${collisionFixtureVector.schemaVersion} sha256=${vectorIdentity} cases=${collisionFixtureVector.cases.length} relations=${collisionFixtureVector.relations.length}`,
    );

    for (const vectorCase of collisionFixtureVector.cases) {
      if ("error" in vectorCase) {
        expect(() => deriveApiRouteCollisionProjection(vectorCase.mountPath, vectorCase.rawPath)).toThrowError(
          expect.objectContaining({ code: vectorCase.error }),
        );
        console.info(`route-collision-vector case=${vectorCase.id} error=${vectorCase.error}`);
        continue;
      }

      const actual = {
        id: vectorCase.id,
        mountPath: vectorCase.mountPath,
        rawPath: vectorCase.rawPath,
        ...deriveApiRouteCollisionProjection(vectorCase.mountPath, vectorCase.rawPath),
      };
      expect(actual).toEqual(vectorCase);
      console.info(`route-collision-vector case=${vectorCase.id} result=${JSON.stringify(actual)}`);
    }

    const collisionShapesById = new Map<string, readonly string[]>();
    for (const vectorCase of collisionFixtureVector.cases) {
      if (!("error" in vectorCase)) {
        collisionShapesById.set(vectorCase.id, vectorCase.collisionShape);
      }
    }
    for (const relation of collisionFixtureVector.relations) {
      const left = collisionShapesById.get(relation.left);
      const right = collisionShapesById.get(relation.right);
      expect(left).toBeDefined();
      expect(right).toBeDefined();
      const sameShape = JSON.stringify(left) === JSON.stringify(right);
      expect(sameShape).toBe(relation.result === "collide");
      console.info(`route-collision-vector relation=${relation.id} result=${relation.result}`);
    }
  });
});

describe("API route-table collision census", () => {
  it("rejects separate terminal registrations and reports every member identity", () => {
    const router = new Hono();
    router.get("/items/:id", terminal("first"));
    router.get("/items/:slug", terminal("second"));

    const error = expectCollision([resolvedMount("catalog", "/api/catalog", 1, router)]);
    expect(error).toMatchObject({
      report: {
        scanned: 1,
        total: 1,
        duplicateGroups: [
          {
            method: "GET",
            collisionShape: ["/api/catalog/items/:p1"],
            records: [
              expect.objectContaining({
                context: "catalog",
                contextMountOrdinal: 1,
                routerOrdinal: 1,
                routeOrdinal: 1,
                rawPath: "/items/:id",
                combinedPath: "/api/catalog/items/:id",
                acceptedPathProjections: [
                  { acceptedPath: "/api/catalog/items/:id", collisionPath: "/api/catalog/items/:p1" },
                ],
                handlerIdentity: expect.objectContaining({
                  name: expect.any(String),
                  arity: 1,
                  sourceSha256: expect.any(String),
                }),
              }),
              expect.objectContaining({ routeOrdinal: 2, rawPath: "/items/:slug" }),
            ],
          },
        ],
      },
    });
  });

  it("rejects a multi-handler verb registration while allowing use plus one verb", () => {
    const invalid = new Hono();
    invalid.get("/x", middleware(), terminal("terminal"));
    expectCollision([resolvedMount("example", "/api/example", 1, invalid)]);

    const valid = new Hono();
    valid.use("/x", middleware());
    valid.get("/x", terminal("terminal"));
    expect(assertApiRouteTableHasNoCollisions([resolvedMount("example", "/api/example", 1, valid)])).toMatchObject({
      scanned: 1,
      total: 1,
      duplicateGroups: [],
    });
  });

  it("rejects stacked and multi-handler use while allowing one composed middleware handler", () => {
    const stacked = new Hono();
    stacked.use("/x", middleware());
    stacked.use("/x", middleware());
    expectCollision([resolvedMount("example", "/api/example", 1, stacked)]);

    const multiHandler = new Hono();
    multiHandler.use("/x", middleware(), middleware());
    expectCollision([resolvedMount("example", "/api/example", 1, multiHandler)]);

    const composed = new Hono();
    composed.use("/x", every(middleware(), middleware()));
    expect(assertApiRouteTableHasNoCollisions([resolvedMount("example", "/api/example", 1, composed)])).toMatchObject({
      duplicateGroups: [],
    });
  });

  it("rejects all plus use while allowing all plus get", () => {
    const invalid = new Hono();
    invalid.all("/x", terminal("all"));
    invalid.use("/x", middleware());
    expectCollision([resolvedMount("example", "/api/example", 1, invalid)]);

    const valid = new Hono();
    valid.all("/x", terminal("all"));
    valid.get("/x", terminal("get"));
    expect(assertApiRouteTableHasNoCollisions([resolvedMount("example", "/api/example", 1, valid)])).toMatchObject({
      duplicateGroups: [],
    });
  });

  it("rejects nested and direct registrations that flatten to the same route", () => {
    const child = new Hono().get("/leaf", terminal("nested"));
    const router = new Hono();
    router.route("/branch", child);
    router.get("/branch/leaf", terminal("direct"));

    expectCollision([resolvedMount("example", "/api/example", 1, router)]);
  });

  it("rejects renamed required parameters while keeping a parameter distinct from a literal", () => {
    const renamed = new Hono();
    renamed.get("/:id", terminal("id"));
    renamed.get("/:slug", terminal("slug"));
    expectCollision([resolvedMount("example", "/api/example", 1, renamed)]);

    const distinct = new Hono();
    distinct.get("/:id", terminal("parameter"));
    distinct.get("/literal", terminal("literal"));
    expect(assertApiRouteTableHasNoCollisions([resolvedMount("example", "/api/example", 1, distinct)])).toMatchObject({
      duplicateGroups: [],
    });
  });

  it("fails closed on an unreadable table", () => {
    const readable = new Hono().get("/ok", terminal("ok"));
    const mounts = [resolvedMount("first", "/api/first", 1, readable), resolvedMount("second", "/api/second", 1, {})];

    expect(() => assertApiRouteTableHasNoCollisions(mounts)).toThrowError(
      expect.objectContaining({
        code: "E_ROUTE_SHAPE",
        report: { scanned: 1, total: 2, routeCount: 1, duplicateGroups: [] },
      }),
    );
  });

  it("fails when the scan does not consume the complete mount collection", () => {
    const first = resolvedMount("first", "/api/first", 1, new Hono().get("/ok", terminal("ok")));
    const second = resolvedMount("second", "/api/second", 1, new Hono().get("/ok", terminal("ok")));
    const mounts = new Proxy([first, second], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          return function* incompleteIterator() {
            const [firstOnly] = target;
            if (firstOnly) {
              yield firstOnly;
            }
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => assertApiRouteTableHasNoCollisions(mounts)).toThrowError(
      expect.objectContaining({
        code: "E_ROUTE_SCAN_INCOMPLETE",
        report: { scanned: 1, total: 2, routeCount: 1, duplicateGroups: [] },
      }),
    );
  });
});
