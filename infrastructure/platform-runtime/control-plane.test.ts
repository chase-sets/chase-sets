import { describe, expect, it } from "vitest";
import { bootstrapPlatformControlPlane, createPostgresPlatformControlPlane } from "./control-plane";

describe("platform control plane", () => {
  it("bootstraps additive coordination tables", async () => {
    const statements: string[] = [];

    await bootstrapPlatformControlPlane({
      query: async (sql) => {
        statements.push(sql);
        return { rows: [], rowCount: 0 };
      },
    });

    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_control_leases");
    expect(statements[0]).toContain("CREATE TABLE IF NOT EXISTS platform_realtime_stream_leases");
  });

  it("uses fenced lease ownership for acquire, renew, and release", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const controlPlane = createPostgresPlatformControlPlane({
      connect: async () => {
        throw new Error("not used");
      },
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes("RETURNING lease_name")) {
          return {
            rows: [
              {
                lease_name: "projector:one",
                owner_id: "worker-a",
                fencing_token: "7",
                expires_at: "2026-05-03T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
        }

        return { rows: [], rowCount: 1 };
      },
    });

    const lease = await controlPlane.acquireLease({
      leaseName: "projector:one",
      ownerId: "worker-a",
      ttlMs: 30_000,
    });

    expect(lease).toMatchObject({
      leaseName: "projector:one",
      ownerId: "worker-a",
      fencingToken: "7",
    });
    await expect(controlPlane.renewLease(lease!, 30_000)).resolves.toBe(true);
    await controlPlane.releaseLease(lease!);
    expect(calls[1].sql).toContain("AND fencing_token = $3::bigint");
    expect(calls[2].sql).toContain("AND fencing_token = $3::bigint");
  });
});
