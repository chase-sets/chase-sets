import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WebContextRegistry } from "./web";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifests = execFileSync("git", ["ls-files", "bounded-contexts/*/context.json"], { cwd: root, encoding: "utf8" })
  .trim()
  .split(/\r?\n/)
  .map((path) => JSON.parse(readFileSync(`${root}/${path}`, "utf8")));
const contexts: WebContextRegistry = manifests.map((manifest) => ({
  contextName: manifest.contextName,
  packageName: manifest.packageName,
  manifest,
}));

describe("canonical link intents", () => {
  it("link-intent-owner-partition", async () => {
    const { composeLinkIntents } = await import("./link-intents");
    const catalog = composeLinkIntents(contexts);
    mkdirSync(`${root}/artifacts/7274`, { recursive: true });
    writeFileSync(
      `${root}/artifacts/7274/owner-route-intent-partition.json`,
      JSON.stringify(catalog.partition, null, 2),
    );
    const routes = manifests.flatMap((m) => m.deployableContributions.flatMap((c: { routes: unknown[] }) => c.routes));
    expect(catalog.partition).toHaveLength(routes.length);
    expect(catalog.partition.some((row) => row.kind === "intent")).toBe(true);
    expect(catalog.partition.every((row) => row.kind === "intent" || row.kind === "indeterminate")).toBe(true);
    for (const intent of catalog.intents) {
      expect(intent.id).toBe(`${intent.owner}.${intent.routeId}`);
      expect(intent.pathParameters).toEqual([...intent.path.matchAll(/:([A-Za-z][\w]*)/g)].map((m) => m[1]));
      expect(intent.missingTarget).toBe("not-found");
      expect(intent.retiredTarget).toBe("reject");
    }
    const changed = JSON.parse(JSON.stringify(contexts));
    changed[0]!.manifest.deployableContributions![0]!.routes[0]!.sourceContext = "unknown-owner";
    expect(() => composeLinkIntents(changed)).toThrow(/owner/);
  });

  it("link-intent-build-parse-closed-matrix", async () => {
    const { composeLinkIntents, buildCanonicalLink, parseCanonicalLink, linkIntentFixtures } =
      await import("./link-intents");
    const catalog = composeLinkIntents(contexts);
    for (const fixture of linkIntentFixtures(catalog)) {
      for (const environment of ["production", "staging"] as const) {
        const built = buildCanonicalLink(catalog, fixture.intentId, fixture.parameters, environment);
        const parsed = parseCanonicalLink(catalog, built.url);
        expect(parsed).toMatchObject({
          kind: "intent",
          intent: { id: fixture.intentId },
          parameters: fixture.parameters,
          environment,
        });
        expect(built.url).toContain(environment === "staging" ? ".staging.chasesets.com/" : ".chasesets.com/");
      }
    }
    const good = "https://marketplace.chasesets.com/items/item-1";
    const bad = [
      "https://other.chasesets.com/items/item-1",
      "http://marketplace.chasesets.com/items/item-1",
      "https://marketplace.chasesets.com:444/items/item-1",
      "https://user@marketplace.chasesets.com/items/item-1",
      "//marketplace.chasesets.com/items/item-1",
      "https://marketplace.chasesets.com/items/../item-1",
      "https://marketplace.chasesets.com/items/%2e%2e",
      "https://marketplace.chasesets.com/items/%ZZ",
      `${good}?market=sell&market=sell`,
      `${good}?unknown=x`,
      `${good}?returnTo=https%3A%2F%2Fevil.example`,
      "https://marketplace.chasesets.com/no-such-intent",
    ];
    for (const input of bad) expect(parseCanonicalLink(catalog, input).kind, input).toBe("rejected");
    expect(parseCanonicalLink(catalog, good).kind).toBe("intent");
    expect(parseCanonicalLink(catalog, "https://marketplace.chasesets.com/account/reviews/received").kind).toBe(
      "rejected",
    );
    expect(() => buildCanonicalLink(catalog, "marketplace.account-review", { path: { reviewId: "received" } })).toThrow(
      /another contributed route/,
    );
    expect(() => buildCanonicalLink(catalog, "unknown", { path: {} })).toThrow(/intent/);
    const invalidParameters = { path: { id: "item-1", nested: {} } };
    expect(() => {
      // @ts-expect-error Deliberately exercise an untyped recursive input at the runtime boundary.
      return buildCanonicalLink(catalog, "discovery.item-detail", invalidParameters);
    }).toThrow(/parameter/);
    expect(() =>
      buildCanonicalLink(catalog, "discovery.item-detail", { path: { id: "item-1" }, query: { market: "invalid" } }),
    ).toThrow(/parameter/);
    const duplicate = {
      ...catalog,
      intents: [...catalog.intents, catalog.intents.find((i) => i.id === "discovery.item-detail")!],
    };
    expect(parseCanonicalLink(duplicate, good)).toMatchObject({ kind: "rejected", reason: "ambiguous-intent" });
  });

  it("link-intent-host-authorization-classification", async () => {
    const { composeLinkIntents, parseCanonicalLink } = await import("./link-intents");
    const catalog = composeLinkIntents(contexts);
    expect(parseCanonicalLink(catalog, "https://admin.chasesets.com/account/purchases/order-1").kind).toBe("rejected");
    const purchase = parseCanonicalLink(catalog, "https://marketplace.chasesets.com/account/purchases/order-1");
    expect(purchase).toMatchObject({
      kind: "intent",
      intent: {
        authorization: { kind: "authenticated" },
        missingTarget: "not-found",
        retiredTarget: "reject",
        webFallback: "same-route",
      },
    });
    expect(purchase).not.toHaveProperty("authorized");
    expect(parseCanonicalLink(catalog, "https://marketplace.chasesets.com/items/item-1")).toMatchObject({
      kind: "intent",
      intent: { authorization: { kind: "public" } },
    });
    expect(
      parseCanonicalLink(catalog, "https://admin.chasesets.com/support/customer-feedback/attention"),
    ).toMatchObject({ kind: "intent", intent: { host: "admin-web", availability: { mobile: false } } });
    expect(parseCanonicalLink(catalog, "https://marketplace.chasesets.com/auth/magic-link?token=secret").kind).toBe(
      "rejected",
    );
  });

  it("link-intent-public-consumer-boundary", async () => {
    const publicContract = await import("@chase-sets/platform-runtime/link-intents");
    const catalog = publicContract.composeLinkIntents(contexts);
    expect(publicContract.linkIntentFixtures(catalog).length).toBe(catalog.intents.length);
    const source = readFileSync(`${root}/infrastructure/platform-runtime/link-intents.ts`, "utf8");
    expect(source).not.toMatch(/from ["'].*(?:bounded-contexts|deployables)\//);
  });
});
