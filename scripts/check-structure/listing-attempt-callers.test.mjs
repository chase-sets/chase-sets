import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enumerateListingAttemptCallers, unpartitionedListingAttemptCallers } from "./marketplace-attempt-callers.mjs";
import { collectMutationConsistencySurfaces } from "./read-after-write-inventory.mjs";

describe("Listing caller guard fail-closed evidence", () => {
  it("classifies every current client mutation and rejects a stale source fingerprint", async () => {
    const contextRoot = "bounded-contexts/marketplace";
    const file = `${contextRoot}/client.ts`;
    const manifest = JSON.parse(readFileSync(new URL(`../../${contextRoot}/context.json`, import.meta.url), "utf8"));
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    const declared = manifest.mutationConsistencyInventory
      .flatMap((entry) => entry.surfaces)
      .filter((surface) => surface.startsWith(`api-client:${file}:`))
      .sort();
    const root = mkdtempSync(path.join(tmpdir(), "cs-listing-client-inventory-"));
    const rootAbs = path.join(root, contextRoot);
    try {
      mkdirSync(rootAbs, { recursive: true });
      const discover = async (content) => {
        writeFileSync(path.join(root, file), content);
        return (
          await collectMutationConsistencySurfaces({
            repoRoot: root,
            contextManifests: new Map([[contextRoot, { root: contextRoot, rootAbs, manifest }]]),
          })
        )
          .filter((surface) => surface.kind === "api-client")
          .map((surface) => surface.id)
          .sort();
      };
      expect(await discover(source)).toEqual(declared);
      const mutant = source.replace(
        'listingRequest("listing.create", { ...body })',
        'listingRequest("listing.create", body)',
      );
      expect(mutant).not.toBe(source);
      expect(await discover(mutant)).not.toEqual(declared);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a key-removal form mutant rather than trusting a known path", () => {
    const path = "bounded-contexts/inventory/features/inventory-items/ui/list-from-inventory-drawer.tsx";
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const check = (text) =>
      unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path, source: text }]));
    expect(check(source)).toEqual([]);
    expect(check(source.replace(/<HiddenInput name="idempotencyKey"[^>]+\/>/, ""))).toHaveLength(1);
  });
  it("rejects keyless non-null and aliased commands outside the planned directory inventory", () => {
    for (const source of ["api.createListing!({});", "const send = api.publishListing; send(id, {});"]) {
      expect(
        unpartitionedListingAttemptCallers(enumerateListingAttemptCallers([{ path: "unusual/a.ts", source }])),
      ).toHaveLength(1);
    }
  });
});
