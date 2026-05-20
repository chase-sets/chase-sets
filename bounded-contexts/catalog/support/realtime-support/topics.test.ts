import { describe, expect, it } from "vitest";
import { authorizeRealtimeTopics } from "@chase-sets/platform-runtime/realtime";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createCatalogAdminInvalidationPatch } from "./projection-patches";
import {
  catalogRealtimeTopicPolicyManifest,
  catalogRealtimeTopics,
} from "./topics";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["catalog.view"],
} satisfies ResolvedActor;

describe("catalog realtime topics", () => {
  it("authorizes catalog admin topics with catalog view permission", () => {
    expect(
      authorizeRealtimeTopics(
        [catalogRealtimeTopics.adminSurface("catalog-items")],
        actor,
        catalogRealtimeTopicPolicyManifest,
      ),
    ).toEqual([catalogRealtimeTopics.adminSurface("catalog-items")]);

    expect(
      authorizeRealtimeTopics(
        [catalogRealtimeTopics.adminSurface("catalog-items")],
        { ...actor, permissions: [] },
        catalogRealtimeTopicPolicyManifest,
      ),
    ).toBeNull();
  });

  it("creates catalog admin projection invalidation patches", () => {
    const patch = createCatalogAdminInvalidationPatch({
      projectionName: "catalog-admin-catalog-item-projection",
      surface: "catalog-items",
      id: "catalog.item-cat_1",
      eventType: "catalog.catalog-item.published",
      topics: [catalogRealtimeTopics.adminSurface("catalog-items")],
    });

    expect(patch).toMatchObject({
      kind: "projection.patch",
      context: "catalog",
      projection: "catalog-admin-catalog-item-projection",
      topics: [catalogRealtimeTopics.adminSurface("catalog-items")],
      changes: [
        {
          op: "summary",
          entity: "catalog.adminProjection",
          id: "catalog-items:catalog.item-cat_1",
        },
      ],
    });
  });
});
