import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, context, owner } from "./db-support";
import { createEbaySellerSetupRuntime } from "../api/setup-runtime";
import { ebaySellerSetupSchemaSql } from "../read-model/schema";
import { choice, location, policy, setupRead } from "./setup-fixtures";
import { readSetupSelection, resolveEbaySetupPolicy } from "../read-model/setup-selection";
import { materialFingerprint, parsePolicyItem } from "../domain/setup-material";
import type { SetupRead } from "../api/setup-listing";
import type { ChannelStorageLocationAuthorityResolver } from "../../connections/domain/contracts";
import { createChannelConnectionRuntime, loadOwned } from "../../connections/api/runtime";
import { ebaySetupDeclaration } from "../domain/configuration";
import { payload } from "../../credentials/tests/fixtures";

const f = fixture("setup_selection");
beforeAll(async () => {
  await f.db().query(ebaySellerSetupSchemaSql);
});
beforeEach(async () => {
  await f.db().query("TRUNCATE channels_ebay_seller_setup");
});
async function setup() {
  const r = f.runtime({ now: () => new Date("2026-11-16T00:00:00Z") });
  vi.mocked(r.provider.exchange).mockResolvedValue({
    ...payload,
    accessExpiresAt: "2030-01-01T00:00:00Z",
    refresh: { kind: "present", token: "synthetic-refresh", expiresAt: "2030-01-01T00:00:00Z" },
  });
  const { connectionId } = await f.connect(r);
  const target = { accountId: owner, connectionId };
  const authority: ChannelStorageLocationAuthorityResolver = {
    resolve: vi.fn(async ({ accountId, storageLocationId }) => ({
      accountId,
      storageLocationId,
      revision: 1,
      status: "active" as const,
    })),
  };
  const runtime = (read: SetupRead = setupRead) =>
    createEbaySellerSetupRuntime({
      db: f.db(),
      eventStore: r.eventStore,
      ebayConnection: r.service,
      storageLocationAuthority: authority,
      read,
      now: () => new Date("2026-11-16T00:00:00Z"),
    });
  const snapshot = async () => ({
    selection: await readSetupSelection(f.db(), owner, connectionId),
    events: (
      await f
        .db()
        .query(
          "SELECT event_type,payload FROM event_store_events WHERE stream_id IN ($1,$2) ORDER BY global_position",
          [`channels.connection-${connectionId}`, `channels.ebay-seller-setup-${connectionId}`],
        )
    ).rows,
  });
  return { r, target, authority, runtime, snapshot };
}
describe("ebay-sandbox-setup-selection", () => {
  it("replaces atomically and fences concurrent initial selection and reselection", async () => {
    const s = await setup();
    const results = await Promise.allSettled([
      s.runtime().select(s.target, choice(), context()),
      s.runtime().select(s.target, choice(), context()),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "generation-conflict" },
    });
    expect((await s.snapshot()).selection?.setupGeneration).toBe(1);
    const reselections = await Promise.allSettled([
      s.runtime().select(s.target, choice(1), context()),
      s.runtime().select(s.target, choice(1), context()),
    ]);
    expect(reselections.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(reselections.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "generation-conflict" },
    });
    await expect(s.runtime().select(s.target, choice(1), context())).rejects.toMatchObject({
      code: "generation-conflict",
    });
    expect((await s.snapshot()).selection?.setupGeneration).toBe(2);
    const replacement = {
      ...choice(2),
      locationPairs: [{ storageLocationId: "storage-2", merchantLocationKey: "warehouse-1" }],
    };
    await s.runtime().select(s.target, replacement, context());
    expect((await loadOwned(s.r.eventStore, owner, s.target.connectionId)).state.bindings).toEqual([
      { storageLocationId: "storage-2", revision: 1 },
    ]);
  });
  it("rejects every invalid selection without changing its baseline or event stream", async () => {
    const s = await setup();
    await s.runtime().select(s.target, choice(), context());
    const before = await s.snapshot();
    const invalid = [
      { ...choice(1), policies: [] },
      { ...choice(1), locationPairs: [] },
      { ...choice(1), locationPairs: [...choice(1).locationPairs, ...choice(1).locationPairs] },
      { ...choice(1), policies: choice().policies.map((p) => ({ ...p, policyId: "unknown" })) },
      { ...choice(1), locationPairs: [{ storageLocationId: "storage-1", merchantLocationKey: "unknown" }] },
    ];
    for (const value of invalid) {
      await expect(s.runtime().select(s.target, value, context())).rejects.toMatchObject({ code: "invalid-selection" });
      expect(await s.snapshot()).toEqual(before);
    }
    for (const status of ["foreign", "retired"] as const) {
      vi.mocked(s.authority.resolve).mockResolvedValue({
        accountId: status === "foreign" ? "acc_other" : owner,
        storageLocationId: "storage-1",
        revision: 1,
        status: status === "retired" ? "retired" : "active",
      });
      await expect(s.runtime().select(s.target, choice(1), context())).rejects.toMatchObject({
        code: "invalid-selection",
      });
      expect(await s.snapshot()).toEqual(before);
    }
    const incomplete: SetupRead = async () => {
      throw new Error("synthetic-failure");
    };
    await expect(s.runtime(incomplete).select(s.target, choice(1), context())).rejects.toMatchObject({
      code: "incomplete",
    });
    expect(await s.snapshot()).toEqual(before);
    await expect(
      s.runtime().select({ ...s.target, accountId: "acc_other" }, choice(1), context("acc_other")),
    ).rejects.toThrow();
    expect(await s.snapshot()).toEqual(before);
  });
  it("rolls selection and selected event back if the shipped activation guard refuses", async () => {
    const s = await setup();
    const before = await s.snapshot();
    vi.mocked(s.authority.resolve)
      .mockResolvedValueOnce({ accountId: owner, storageLocationId: "storage-1", revision: 1, status: "active" })
      .mockResolvedValue(null);
    await expect(s.runtime().select(s.target, choice(), context())).rejects.toMatchObject({
      code: "binding-not-current",
    });
    expect(await s.snapshot()).toEqual(before);
  });
});
describe("ebay-sandbox-setup-activation", () => {
  it("requires all selected policies and a current credential through the shipped guard", async () => {
    const s = await setup();
    const connections = createChannelConnectionRuntime(
      { eventStore: s.r.eventStore, db: f.db() },
      {
        setupResolver: { resolve: async () => ebaySetupDeclaration },
        storageLocationAuthority: s.authority,
        policyAuthority: { resolve: (input) => resolveEbaySetupPolicy(f.db(), input) },
        credentialAuthority: {
          resolve: async () => ({
            accountId: owner,
            providerKey: "ebay",
            environment: "sandbox",
            generation: 1,
            status: "current",
          }),
        },
      },
    );
    const envelope = (await f.envelopes())[0];
    await expect(
      connections.activateChannelConnection(
        {
          ...s.target,
          credentialReference: envelope.row_id,
          bindings: [{ storageLocationId: "storage-1", revision: 1 }],
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "required-policy-incomplete" });
    const result = await s.runtime().select(s.target, choice(), context());
    expect(result.status).toBe("active");
    const loaded = await loadOwned(s.r.eventStore, owner, s.target.connectionId);
    expect(loaded.state).toMatchObject({
      status: "active",
      credentialReference: envelope.row_id,
      bindings: [{ storageLocationId: "storage-1", revision: 1 }],
    });
    await f.db().query("DELETE FROM channels_connection_credentials WHERE connection_id=$1", [s.target.connectionId]);
    const before = await s.snapshot();
    await expect(s.runtime().select(s.target, choice(1), context())).rejects.toThrow();
    expect(await s.snapshot()).toEqual(before);
  });
  it("refuses an expired access token without provider traffic or writes", async () => {
    const s = await setup();
    const expired = f.runtime({ now: () => new Date("2031-01-01T00:00:00Z") });
    const read = vi.fn(setupRead);
    const runtime = createEbaySellerSetupRuntime({
      db: f.db(),
      eventStore: s.r.eventStore,
      ebayConnection: expired.service,
      storageLocationAuthority: s.authority,
      read,
    });
    await expect(runtime.select(s.target, choice(), context())).rejects.toMatchObject({
      code: "credential-not-current",
    });
    expect(read).not.toHaveBeenCalled();
    expect((await s.snapshot()).selection).toBeNull();
  });
});
describe("ebay-sandbox-setup-material-baseline", () => {
  it("persists and publishes command-read material, same-id changes and paging-invariant fingerprints", async () => {
    const s = await setup();
    await s.runtime().load(s.target);
    expect((await s.snapshot()).selection).toBeNull();
    const changed: SetupRead = async (url, token, signal) =>
      url.includes("fulfillment_policy")
        ? { total: 1, fulfillmentPolicies: [policy("fulfillment", "Changed after page load")] }
        : setupRead(url, token, signal);
    const first = await s.runtime(changed).select(s.target, choice(), context());
    expect(first.selection.policies[0].materialFingerprint).toBe(
      materialFingerprint(parsePolicyItem("fulfillment", policy("fulfillment", "Changed after page load"))),
    );
    const event = (
      await s.r.eventStore.readStream({ streamId: `channels.ebay-seller-setup-${s.target.connectionId}` })
    )[0];
    expect(event).toMatchObject({
      eventType: "channels.ebay-seller-setup.selected",
      payload: first.selection,
      occurredAt: "2026-11-16T00:00:00.000Z",
    });
    expect((await s.snapshot()).selection).toEqual(first.selection);
    const second = await s.runtime().select(s.target, choice(1), context());
    expect(second.selection.policies[0].materialFingerprint).not.toBe(first.selection.policies[0].materialFingerprint);
    const paging: SetupRead = async (url, token, signal) =>
      url.includes("/location")
        ? {
            href: url,
            offset: 0,
            total: 1,
            limit: 100,
            locations: [Object.fromEntries(Object.entries(location()).reverse())],
          }
        : setupRead(url, token, signal);
    const third = await s.runtime(paging).select(s.target, choice(2), context());
    expect(third.selection.locationPairs[0].materialFingerprint).toBe(
      second.selection.locationPairs[0].materialFingerprint,
    );
  });
});
