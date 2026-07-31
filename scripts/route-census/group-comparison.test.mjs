import { beforeAll, describe, expect, it } from "vitest";
import { compareDuplicateGroups } from "./comparison.mts";
import { deriveDuplicateGroups } from "./model.mts";
import { clone, makeCapture, syntheticContext } from "./test-support.mjs";

let context;
let base;

beforeAll(async () => {
  context = await syntheticContext();
  base = await makeCapture(context);
});

function groups(rows) {
  return deriveDuplicateGroups(rows);
}

describe("stable duplicate-group multiset comparison", () => {
  it.each(["row", "mount", "router"])("ignores unrelated preceding %s insertion for group identity", async (kind) => {
    const unrelatedCapture = await makeCapture(context, { routes: ["/other", "/items/:id", "/items/:slug"] });
    const shifted = clone(unrelatedCapture.censusRows);
    if (kind === "mount")
      shifted.slice(1).forEach((row) => {
        row.mountIndex += 10;
        row.contextMountOrdinal += 10;
      });
    if (kind === "router")
      shifted.slice(1).forEach((row) => {
        row.routerOrdinal += 10;
        row.routeOrdinal += 10;
      });
    expect(compareDuplicateGroups(base.duplicateGroups, groups(shifted))).toEqual([]);
  });

  it("reports a third semantic member as one changed group", async () => {
    const candidate = await makeCapture(context, { routes: ["/items/:id", "/items/:slug", "/items/:name"] });
    expect(compareDuplicateGroups(base.duplicateGroups, candidate.duplicateGroups)).toEqual([
      expect.objectContaining({ kind: "changed", method: "GET", collisionShape: ["/api/items/:p1"] }),
    ]);
  });

  it("reports collapse from two members to one as one removed group", async () => {
    const candidate = await makeCapture(context, { routes: ["/items/:id"] });
    expect(compareDuplicateGroups(base.duplicateGroups, candidate.duplicateGroups)).toEqual([
      expect.objectContaining({ kind: "removed", candidateMembers: null }),
    ]);
  });

  it("adds a lexically earlier group without cascading later display labels", async () => {
    const later = await makeCapture(context, { routes: ["/z/:id", "/z/:slug"] });
    const candidate = await makeCapture(context, {
      routes: ["/a/:id", "/a/:slug", "/z/:id", "/z/:slug"],
    });
    expect(compareDuplicateGroups(later.duplicateGroups, candidate.duplicateGroups)).toEqual([
      expect.objectContaining({ kind: "added", collisionShape: ["/api/a/:p1"] }),
    ]);
  });

  it("preserves identical stable occurrences as a count multiset", async () => {
    const candidate = await makeCapture(context, {
      routes: ["/items/:id", "/items/:id", "/items/:id"],
      routeHandlers: [{}, {}, {}],
    });
    const identicalBase = await makeCapture(context, { routes: ["/items/:id", "/items/:id"] });
    const diff = compareDuplicateGroups(identicalBase.duplicateGroups, candidate.duplicateGroups);
    expect(diff).toHaveLength(1);
    expect(diff[0].kind).toBe("changed");
    expect(diff[0].baseMembers).toEqual([expect.objectContaining({ count: 2 })]);
    expect(diff[0].candidateMembers).toEqual([expect.objectContaining({ count: 3 })]);
  });

  it("treats display IDs as non-authoritative", () => {
    const renumbered = clone(base.duplicateGroups);
    renumbered[0].displayId = "D999";
    expect(compareDuplicateGroups(base.duplicateGroups, renumbered)).toEqual([]);
  });
});
