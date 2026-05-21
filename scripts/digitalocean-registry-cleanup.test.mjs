import { describe, expect, it } from "vitest";
import { fetchProtectedAppTags, selectTagsForDeletion } from "./digitalocean-registry-cleanup.mjs";

describe("digitalocean-registry-cleanup", () => {
  it("selects only old unprotected registry tags for deletion", () => {
    const now = new Date("2026-05-15T12:00:00.000Z");

    expect(
      selectTagsForDeletion(
        [
          { tag: "current-staging", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "current-production", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "release-20260515-abcdef12", updated_at: "2026-04-01T00:00:00.000Z" },
          { tag: "recent-main", updated_at: "2026-05-01T00:00:00.000Z" },
          { tag: "old-main", updated_at: "2026-03-01T00:00:00.000Z" },
          { tag: "digest-protected", digest: "sha256:keep", updated_at: "2026-03-01T00:00:00.000Z" },
        ],
        {
          now,
          retentionDays: 30,
          protectedTags: ["current-staging", "current-production"],
          protectedDigests: ["sha256:keep"],
        },
      ),
    ).toEqual(["old-main"]);
  });

  it("fetches protected image tags from named App Platform specs", async () => {
    const tags = await fetchProtectedAppTags(["chase-sets-staging-platform"], {
      commandOutput: async (_command, args) => {
        if (args[1] === "list") {
          return JSON.stringify([
            {
              id: "app-id",
              spec: { name: "chase-sets-staging-platform" },
            },
            {
              id: "other-id",
              spec: { name: "unrelated" },
            },
          ]);
        }

        return JSON.stringify({
          spec: {
            services: [{ image: { tag: "staging-sha" } }],
            workers: [{ image: { tag: "worker-sha" } }],
            jobs: [{ image: { tag: "bootstrap-sha" } }],
          },
        });
      },
    });

    expect(tags).toEqual(["staging-sha", "worker-sha", "bootstrap-sha"]);
  });
});
