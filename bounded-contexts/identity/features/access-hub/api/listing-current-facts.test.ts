import { expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { identityFixture } from "./listing-authority-test-support";
import { createIdentityListingCurrentFacts } from "./listing-current-facts";

it("reads actual current seller facts without projections, grants, or writes", async () => {
  const f = await identityFixture();
  await f.accounts.commandHandler({
    streamId: `identity.account-${f.accountId}`,
    context: f.audit,
    command: { type: "AssignAccountBadge", badgeKey: "trusted-seller" },
  });
  const before = structuredClone([...f.memory.streams]);
  const read = createIdentityListingCurrentFacts(f.memory.eventStore);
  const facts = await read(f.accountId, { maxAgeMs: 1000 });
  expect(facts.value).toEqual({ accountId: f.accountId, active: true, badgeKeys: ["trusted-seller"] });
  expect(Date.parse(facts.validBefore)).toBeGreaterThan(Date.parse(facts.generatedAt));
  expect([...f.memory.streams]).toEqual(before);
});

it("reports an actually suspended account as inactive", async () => {
  const f = await identityFixture();
  await f.accounts.commandHandler({
    streamId: `identity.account-${f.accountId}`,
    context: f.audit,
    command: {
      type: "SuspendAccount",
      enforcement: {
        version: 1,
        enforcementActionId: createId("enf"),
        reason: "policy-violation",
        reference: null,
      },
    },
  });
  const facts = await createIdentityListingCurrentFacts(f.memory.eventStore)(f.accountId, { maxAgeMs: 1000 });
  expect(facts.value.active).toBe(false);
});

it("rejects absent history instead of treating the initial active state as a seller", async () => {
  const f = await identityFixture();
  await expect(
    createIdentityListingCurrentFacts(f.memory.eventStore)("acc_missing", { maxAgeMs: 1000 }),
  ).rejects.toThrow("missing or mismatched");
});

it("rejects a canonical account change during the read", async () => {
  const f = await identityFixture();
  const original = f.memory.eventStore.readStream.bind(f.memory.eventStore);
  const readStream = vi.fn(async (input: Parameters<typeof original>[0]) => {
    if (input.limit === 2) {
      await f.accounts.commandHandler({
        streamId: `identity.account-${f.accountId}`,
        context: f.audit,
        command: { type: "AssignAccountBadge", badgeKey: "trusted-seller" },
      });
    }
    return original(input);
  });
  const read = createIdentityListingCurrentFacts({ ...f.memory.eventStore, readStream });
  await expect(read(f.accountId, { maxAgeMs: 1000 })).rejects.toThrow("changed");
});

it("rejects account history lost between the fold and current-source check", async () => {
  const f = await identityFixture();
  const original = f.memory.eventStore.readStream.bind(f.memory.eventStore);
  const read = createIdentityListingCurrentFacts({
    ...f.memory.eventStore,
    readStream: async (input) => {
      if (input.limit === 2) f.memory.streams.delete(input.streamId);
      return original(input);
    },
  });
  await expect(read(f.accountId, { maxAgeMs: 1000 })).rejects.toThrow("changed");
});

it("rejects an expired read budget and invalid input", async () => {
  const f = await identityFixture();
  const now = vi.fn().mockReturnValueOnce(new Date(1000)).mockReturnValue(new Date(2000));
  const read = createIdentityListingCurrentFacts(f.memory.eventStore, now);
  await expect(read(f.accountId, { maxAgeMs: 1000 })).rejects.toThrow("read-age budget");
  await expect(read(f.accountId, { maxAgeMs: 0 })).rejects.toThrow("positive read-age budget");
  await expect(read(" ", { maxAgeMs: 1000 })).rejects.toThrow("positive read-age budget");
});
