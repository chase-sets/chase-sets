import { describe, expect, it, vi } from "vitest";
import { ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ROLE_KEYS } from "../../../support/runtime-support/common";
import { buildMembershipProjectionHandlers } from "./projection";

async function projectedPermissions(roleKey: string) {
  const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
    rows: [{ user_id: "usr_synthetic_pricing", account_id: "acc_synthetic_pricing", status: "active" }],
  }));
  const handlers = buildMembershipProjectionHandlers({ query } as PgQueryable);
  const written: Record<string, string[]> = {};
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
    written[type] = JSON.parse(String(write![1]![type.endsWith("granted") ? 4 : 2]));
  }
  return written;
}

describe("membership pricing projection", () => {
  it.each(["owner", "manager", "fulfillment", "viewer", "platform-admin"])(
    "projects current pricing presets on grant and role change: %s",
    async (roleKey) => {
      for (const permissions of Object.values(await projectedPermissions(roleKey))) {
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

describe("membership role permission projection", () => {
  it("has permissions for every runtime role key", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLE_KEYS].sort());
  });

  it.each(ROLE_KEYS)("writes the canonical role table on grant and role change: %s", async (roleKey) => {
    const written = await projectedPermissions(roleKey);
    expect(written).toEqual({
      "identity.membership.granted": ROLE_PERMISSIONS[roleKey],
      "identity.membership.role-changed": ROLE_PERMISSIONS[roleKey],
    });
    for (const permissions of Object.values(written)) {
      expect(permissions.filter((key) => key === "payout-review-holds.manage")).toEqual(
        roleKey === "platform-admin" ? ["payout-review-holds.manage"] : [],
      );
    }
  });
});
