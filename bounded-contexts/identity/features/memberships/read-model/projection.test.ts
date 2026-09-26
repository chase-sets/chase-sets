import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildMembershipProjectionHandlers } from "./projection";

describe("membership pricing projection", () => {
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "projects current pricing presets on grant and role change: %s",
    async (roleKey) => {
      const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
        rows: [{ user_id: "usr_synthetic_pricing", account_id: "acc_synthetic_pricing", status: "active" }],
      }));
      const handlers = buildMembershipProjectionHandlers({ query } as PgQueryable);
      for (const type of ["identity.membership.granted", "identity.membership.role-changed"]) {
        query.mockClear();
        await handlers[type]!(
          buildTransportEvent(
            type,
            {
              membershipId: "mbr_synthetic_pricing",
              userId: "usr_synthetic_pricing",
              accountId: "acc_synthetic_pricing",
              roleKey,
            },
            { streamId: "identity.membership-mbr_synthetic_pricing" },
          ),
        );
        const write = query.mock.calls.find(([sql]) => sql.includes("role_permissions"));
        expect(write).toBeDefined();
        const permissions: string[] = JSON.parse(String(write![1]![type.endsWith("granted") ? 4 : 2]));
        expect(permissions.filter((key) => key.startsWith("pricing.")).sort()).toEqual(
          roleKey === "platform-admin"
            ? []
            : ["owner", "manager"].includes(roleKey)
              ? ["pricing.manage", "pricing.view"]
              : ["pricing.view"],
        );
      }
    },
  );
});
