import { describe, expect, it } from "vitest";
import { ADMIN_QA_ACTOR_FIXTURES } from "@chase-sets/identity/server";
import { listAccountSelectionMemberships } from "../../features/account-selection/read-model/queries";

describe("Admin QA Auth projection contract", () => {
  it("has the canonical viewer aliases and exactly two viewer accounts", () => {
    const viewer = ADMIN_QA_ACTOR_FIXTURES.find((fixture) => fixture.actorAlias === "admin-qa-viewer");
    expect(viewer?.accountName).toBe("Admin QA Viewer Primary");
    expect(viewer?.roleKey).toBe("viewer");
    expect(ADMIN_QA_ACTOR_FIXTURES).toHaveLength(6);
  });

  it("account selection reads active Account and Membership projections", async () => {
    let sql = "";
    const query = async (text: string) => {
      sql = text;
      return { rows: [] };
    };
    await listAccountSelectionMemberships({ query } as never, "usr_admin_qa_viewer");
    expect(sql).toContain("memberships.status = 'active'");
    expect(sql).toContain("accounts.status = 'active'");
  });
});
