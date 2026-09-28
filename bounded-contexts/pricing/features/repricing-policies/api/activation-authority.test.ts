import { expect, it } from "vitest";
import type { PostgresEventStore } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition, type AppendToStreamInput, type StoredEvent } from "@chase-sets/event-core/storage";
import { fixture } from "../../repricing-engine/tests/listing-authority-fixture";
import { sqlFixture } from "../../repricing-engine/tests/listing-authority-sql-fixture";
import { dryRunBody } from "../../repricing-engine/tests/dry-run-fixture";
import { hashRepricingDryRunBody } from "../../repricing-engine/api/dry-run";
import { createRepricingPolicyActivationServices, DryRunRequiredError } from "./activation";

it.each([false, true])(
  "activation has one atomic consumption/creation receipt after commit loss; rejected=%s",
  async (rejected) => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const sql = sqlFixture({ consumed: false, policies: [] as string[] }, (data, query, values) => {
      if (query.includes("SELECT run.body"))
        return {
          rows: [
            {
              body: dryRunBody,
              body_hash: hashRepricingDryRunBody(dryRunBody),
              status: rejected ? "queued" : "completed",
              consumed_at: data.consumed ? "2026-09-28T00:00:00.000Z" : null,
              job_status: "completed",
            },
          ],
        };
      if (query.includes("UPDATE pricing_repricing_dry_runs")) {
        if (data.consumed) return { rows: [] };
        data.consumed = true;
        return { rows: [{ dry_run_id: "synthetic-activation" }] };
      }
      if (query === "synthetic-policy-append") {
        const input = values[0] as AppendToStreamInput;
        data.policies.push(input.streamId);
        return {
          rows: input.events.map((event, i) => ({
            ...event,
            eventId: `evt_synthetic_policy_${i}`,
            streamId: input.streamId,
            streamVersion: i + 1,
            globalPosition: parseGlobalPosition(String(i + 1)),
            tenantId: input.context.tenantId,
            performedByUserId: input.context.audit.performedByUserId,
            forAccountId: input.context.audit.forAccountId,
            metadata: {},
            occurredAt: "2026-09-28T00:00:00.000Z",
            recordedAt: "2026-09-28T00:00:00.000Z",
          })),
        };
      }
      throw new Error(`Unexpected activation SQL: ${query}`);
    });
    const eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction"> = {
      appendToStreamInTransaction: async (client, input) => {
        expect(sql.inTransaction).toBe(true);
        expect((await f.fence.inspect(operation)).status).toBe("aborted");
        return (await client.query<StoredEvent>("synthetic-policy-append", [input])).rows;
      },
    };
    const services = () =>
      createRepricingPolicyActivationServices({ pool: sql.pool, eventStore, authority: f.restart().source });
    const input = {
      accountId: f.context.audit.forAccountId,
      dryRunId: "synthetic-activation",
      name: "Synthetic activation",
    };
    sql.loseNextCommit();
    await expect(services().activateRepricingPolicy(input, f.context)).rejects.toThrow("unresolved");
    expect(sql.receipts.size).toBe(1);
    if (rejected) {
      await expect(services().activateRepricingPolicy(input, f.context)).rejects.toBeInstanceOf(DryRunRequiredError);
      expect(sql.data.consumed).toBe(false);
      expect(sql.data.policies).toEqual([]);
    } else {
      const policy = await services().activateRepricingPolicy(input, f.context);
      expect(policy).toMatchObject({ status: "active", name: input.name, accountId: input.accountId });
      expect(await services().activateRepricingPolicy(input, f.context)).toEqual(policy);
      expect(sql.data.consumed).toBe(true);
      expect(sql.data.policies).toHaveLength(1);
    }
    await expect(
      services().activateRepricingPolicy({ ...input, name: "Different request" }, f.context),
    ).rejects.toThrow("identity conflict");
  },
);
