import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutEnglishTranslations } from "@chase-sets/localization/locales/en/checkout";
import { describe, expect, it, vi } from "vitest";
import {
  sellerCheckoutLabelPreferences,
  type SellerCheckoutReadinessKey,
  type SellerCheckoutReadinessResult,
} from "../domain/contract";
import matrix from "./authority-matrix.fixture.json" with { type: "json" };
import { readSellerCheckoutReadiness, type SellerCheckoutReadinessFacts } from "./queries";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function repoSource(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function unionMembers(source: string, typeName: string) {
  const declaration = source.match(new RegExp(`export type ${typeName} =([^;]+);`));
  return [...(declaration?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const shipFromLocationId = "sfl_01JLOCATION000000000000000";
const recordedAt = "2026-10-29T14:00:00.000Z";

const accountKey: SellerCheckoutReadinessKey = {
  owner: { kind: "account", accountId: "acc_01JSELLER000000000000000000" },
  shipFromLocationId,
  labelPreference: "prepaid-label",
};

const anonymousKey: SellerCheckoutReadinessKey = {
  owner: { kind: "anonymous", anonymousSellListId: "anon_01JGUEST00000000000000000" },
  shipFromLocationId,
  labelPreference: "prepaid-label",
};

function facts(overrides: Partial<SellerCheckoutReadinessFacts> = {}): SellerCheckoutReadinessFacts {
  return {
    owner: accountKey.owner,
    shipFromLocationId,
    revision: 7,
    recordedAt,
    mergedIntoAccountId: null,
    labelPreferences: [
      { labelPreference: "prepaid-label", availability: "available", revision: 7 },
      { labelPreference: "seller-label-later", availability: "unavailable", revision: 7 },
    ],
    providerRoutes: [{ labelPreference: "prepaid-label", availability: "available", revision: 7 }],
    ...overrides,
  };
}

function read(record: SellerCheckoutReadinessFacts | null, key: SellerCheckoutReadinessKey = accountKey) {
  return readSellerCheckoutReadiness(async () => record, key);
}

const ready = { status: "ready", reason: "ready" };
const labelBlocked = (fact: string) => ({ status: "blocked", reason: "label-not-ready", fact });
const providerBlocked = (fact: string) => ({ status: "blocked", reason: "provider-not-ready", fact });

function blockedEverywhere(fact: string) {
  return {
    schemaVersion: "fulfillment.seller-checkout-readiness.v1",
    label: labelBlocked(fact),
    provider: providerBlocked(fact),
    sourceRevision: null,
    sourceTimestamp: null,
  };
}

describe("seller checkout readiness authority matrix", () => {
  it("names symbols the contract and read export", () => {
    const contract = repoSource(matrix.authority.contract);
    const read = repoSource(matrix.authority.read);
    for (const symbol of matrix.authority.contractSymbols) {
      expect(contract).toMatch(new RegExp(`export type ${symbol}\\b`));
    }
    for (const symbol of matrix.authority.readSymbols) {
      expect(read).toMatch(new RegExp(`export (?:type|async function) ${symbol}\\b`));
    }
    expect([...sellerCheckoutLabelPreferences]).toEqual(matrix.key.labelPreferences);
  });

  it("reads each owner kind only by an id of its own kind, at the scope, revision and timestamp it names", async () => {
    for (const owner of matrix.key.owners) {
      const key = {
        owner: { kind: owner.kind, [owner.idField]: `${owner.idPrefix}01JMATRIX0000000000000000` },
        shipFromLocationId,
        labelPreference: "prepaid-label",
      } as unknown as SellerCheckoutReadinessKey;
      const result = await read(facts({ owner: key.owner }), key);
      expect(result).toMatchObject({ label: ready, provider: ready });
      expect(result[matrix.revision.field as keyof SellerCheckoutReadinessResult]).toBe(7);
      expect(result[matrix.timestamp.field as keyof SellerCheckoutReadinessResult]).toBe(recordedAt);
      for (const field of matrix.key.scope) {
        const outOfScope = { ...key, [field]: "sfl_or_preference_not_recorded" } as SellerCheckoutReadinessKey;
        await expect(read(facts({ owner: key.owner }), outOfScope)).resolves.toMatchObject({
          label: { status: "blocked" },
          provider: { status: "blocked" },
        });
      }

      const otherKind = matrix.key.owners.find((candidate) => candidate.kind !== owner.kind);
      const crossed = {
        ...key,
        owner: { kind: owner.kind, [owner.idField]: `${otherKind?.idPrefix}01JMATRIX0000000000000000` },
      } as unknown as SellerCheckoutReadinessKey;
      const source = vi.fn(async () => facts({ owner: crossed.owner }));
      await expect(readSellerCheckoutReadiness(source, crossed)).resolves.toEqual(blockedEverywhere("missing"));
      expect(source).not.toHaveBeenCalled();
    }
  });

  it("covers exactly the label and provider dimensions and leaves every unowned Checkout dimension out", async () => {
    const consumer = repoSource(matrix.checkoutAdapterBoundary.consumer);
    const owned = matrix.dimensions.map((dimension) => dimension.dimension);
    expect([...owned, ...matrix.unownedDimensions].sort()).toEqual(
      unionMembers(consumer, matrix.checkoutAdapterBoundary.consumerDimensionType).sort(),
    );
    expect(matrix.dimensions.map((dimension) => dimension.resultField)).toEqual(["label", "provider"]);
    expect(Object.keys(await read(facts())).sort()).toEqual([
      "label",
      "provider",
      "schemaVersion",
      "sourceRevision",
      "sourceTimestamp",
    ]);
  });

  it("keeps a dimension without its owner fact blocked instead of defaulting it ready", async () => {
    for (const dimension of matrix.dimensions) {
      const withoutOwnerFact = { ...facts(), [dimension.factField]: [] } as SellerCheckoutReadinessFacts;
      const result = await read(withoutOwnerFact);
      expect(result[dimension.resultField as "label" | "provider"]).toEqual({
        status: "blocked",
        reason: dimension.blockedReason,
        fact: "missing",
      });
    }
  });

  it("produces every blocking fact it names", async () => {
    const results = await Promise.all([
      read(null),
      read(facts({ revision: 8 })),
      read(facts({ shipFromLocationId: "sfl_01JOTHERLOCATION0000000000" })),
      read(facts({ providerRoutes: [{ labelPreference: "prepaid-label", availability: "unavailable", revision: 7 }] })),
    ]);
    const produced = new Set(
      results.flatMap((result) =>
        [result.label, result.provider].flatMap((dimension) =>
          dimension.status === "blocked" ? [dimension.fact] : [],
        ),
      ),
    );
    expect([...produced].sort()).toEqual(Object.keys(matrix.blockingFacts).sort());
  });

  it("names a Checkout adapter boundary whose reasons, trusted anonymous header and callers exist", () => {
    const boundary = matrix.checkoutAdapterBoundary;
    const reasons = unionMembers(repoSource(boundary.consumer), boundary.consumerReasonType);
    expect(reasons).toEqual(expect.arrayContaining(["ready", ...matrix.dimensions.map((d) => d.blockedReason)]));
    for (const caller of boundary.callers) {
      expect(repoSource(caller.file)).toContain(caller.handler);
    }
    const anonymous = matrix.key.owners.find((owner) => owner.kind === "anonymous");
    expect(repoSource(boundary.callers[0].file)).toContain(`"${anonymous?.trustedBoundary}"`);
    expect([...new Set(boundary.callers.map((caller) => caller.moment))]).toEqual(matrix.lifecycle.moments);
    expect([...new Set(boundary.callers.map((caller) => caller.owner))]).toEqual(
      matrix.key.owners.map((owner) => owner.kind),
    );
  });
});

describe("readSellerCheckoutReadiness", () => {
  it("reads label and provider ready with the record revision and timestamp for the same owner and Ship-From Location", async () => {
    await expect(read(facts())).resolves.toEqual({
      schemaVersion: "fulfillment.seller-checkout-readiness.v1",
      label: ready,
      provider: ready,
      sourceRevision: 7,
      sourceTimestamp: recordedAt,
    });
    await expect(read(facts({ owner: anonymousKey.owner }), anonymousKey)).resolves.toMatchObject({
      label: ready,
      provider: ready,
      sourceRevision: 7,
    });
  });

  it("blocks facts recorded for another owner or Ship-From Location as conflicting without exposing their revision", async () => {
    await expect(read(facts({ owner: anonymousKey.owner }), accountKey)).resolves.toEqual(
      blockedEverywhere("conflicting"),
    );
    await expect(read(facts(), anonymousKey)).resolves.toEqual(blockedEverywhere("conflicting"));
    await expect(
      read(facts({ owner: { kind: "account", accountId: "acc_01JOTHERSELLER0000000000000" } })),
    ).resolves.toEqual(blockedEverywhere("conflicting"));
    await expect(read(facts({ shipFromLocationId: "sfl_01JOTHERLOCATION0000000000" }))).resolves.toEqual(
      blockedEverywhere("conflicting"),
    );
  });

  it("blocks a key that cannot name an owner fact without reading facts", async () => {
    const keys = [
      { ...accountKey, owner: { kind: "account", accountId: "anon_01JGUEST00000000000000000" } },
      { ...accountKey, owner: { kind: "anonymous", anonymousSellListId: "acc_01JSELLER000000000000000000" } },
      { ...accountKey, owner: { kind: "account", accountId: "acc_" } },
      { ...accountKey, owner: { kind: "seller", accountId: "acc_01JSELLER000000000000000000" } },
      { ...accountKey, owner: null },
      { ...accountKey, shipFromLocationId: "  " },
      { ...accountKey, labelPreference: "free-label" },
    ] as unknown as SellerCheckoutReadinessKey[];
    for (const key of keys) {
      const source = vi.fn(async () => facts());
      await expect(readSellerCheckoutReadiness(source, key)).resolves.toEqual(blockedEverywhere("missing"));
      expect(source).not.toHaveBeenCalled();
    }
  });

  it("blocks missing facts, a missing preference fact and a missing provider route", async () => {
    await expect(read(null)).resolves.toEqual(blockedEverywhere("missing"));
    await expect(read(facts({ labelPreferences: [] }))).resolves.toMatchObject({
      label: labelBlocked("missing"),
      provider: ready,
      sourceRevision: 7,
      sourceTimestamp: recordedAt,
    });
    await expect(
      read(
        facts({ providerRoutes: [{ labelPreference: "seller-label-later", availability: "available", revision: 7 }] }),
      ),
    ).resolves.toMatchObject({ label: ready, provider: providerBlocked("missing"), sourceRevision: 7 });
  });

  it("blocks a fact evaluated before its record revision as stale and one ahead of it as conflicting", async () => {
    await expect(read(facts({ revision: 8 }))).resolves.toMatchObject({
      label: labelBlocked("stale"),
      provider: providerBlocked("stale"),
      sourceRevision: 8,
    });
    await expect(
      read(facts({ providerRoutes: [{ labelPreference: "prepaid-label", availability: "available", revision: 8 }] })),
    ).resolves.toMatchObject({ label: ready, provider: providerBlocked("conflicting"), sourceRevision: 7 });
  });

  it("blocks more than one fact for the requested preference as conflicting", async () => {
    await expect(
      read(
        facts({
          labelPreferences: [
            { labelPreference: "prepaid-label", availability: "available", revision: 7 },
            { labelPreference: "prepaid-label", availability: "available", revision: 7 },
          ],
        }),
      ),
    ).resolves.toMatchObject({ label: labelBlocked("conflicting"), provider: ready });
  });

  it("blocks an unavailable preference or provider route and facts that cannot be read", async () => {
    await expect(read(facts(), { ...accountKey, labelPreference: "seller-label-later" })).resolves.toMatchObject({
      label: labelBlocked("unavailable"),
      provider: providerBlocked("missing"),
    });
    await expect(
      read(facts({ providerRoutes: [{ labelPreference: "prepaid-label", availability: "unavailable", revision: 7 }] })),
    ).resolves.toMatchObject({ label: ready, provider: providerBlocked("unavailable") });
    await expect(
      readSellerCheckoutReadiness(async () => {
        throw new Error("fact store offline");
      }, accountKey),
    ).resolves.toEqual(blockedEverywhere("unavailable"));
    for (const malformed of [
      { revision: -1 },
      { revision: 7.5 },
      { revision: Number.NaN },
      { revision: "7" as unknown as number },
      { recordedAt: "not-a-timestamp" },
      { recordedAt: 1_793_282_400_000 as unknown as string },
    ]) {
      await expect(read(facts(malformed))).resolves.toEqual(blockedEverywhere("unavailable"));
    }
  });

  it("invalidates anonymous facts after a guest-to-account merge and never carries them to the Account key", async () => {
    const anonymousFacts = facts({ owner: anonymousKey.owner });
    await expect(read(anonymousFacts, anonymousKey)).resolves.toMatchObject({ label: ready, provider: ready });

    const merged = facts({
      owner: anonymousKey.owner,
      revision: 8,
      recordedAt: "2026-10-29T14:05:00.000Z",
      mergedIntoAccountId: "acc_01JSELLER000000000000000000",
      labelPreferences: [{ labelPreference: "prepaid-label", availability: "available", revision: 8 }],
      providerRoutes: [{ labelPreference: "prepaid-label", availability: "available", revision: 8 }],
    });
    await expect(read(merged, anonymousKey)).resolves.toMatchObject({
      label: labelBlocked("stale"),
      provider: providerBlocked("stale"),
      sourceRevision: 8,
    });
    await expect(read(merged, accountKey)).resolves.toEqual(blockedEverywhere("conflicting"));
    await expect(read(null, accountKey)).resolves.toEqual(blockedEverywhere("missing"));

    const rekeyed = { ...merged, owner: accountKey.owner, mergedIntoAccountId: null };
    await expect(read(rekeyed, accountKey)).resolves.toMatchObject({
      label: ready,
      provider: ready,
      sourceRevision: 8,
    });
  });

  it("ignores forged posted statuses on the key and on facts", async () => {
    const forgedKey = {
      ...accountKey,
      status: "ready",
      label: { status: "ready" },
      provider: { status: "ready" },
      sellerEvidence: { label: { status: "ready", preference: "prepaid-label" }, provider: { status: "ready" } },
    } as SellerCheckoutReadinessKey;
    const source = vi.fn(async (_key: SellerCheckoutReadinessKey) => null);
    await expect(readSellerCheckoutReadiness(source, forgedKey)).resolves.toEqual(blockedEverywhere("missing"));
    expect(source).toHaveBeenCalledTimes(1);
    expect(source.mock.calls[0][0]).toStrictEqual(accountKey);

    for (const availability of ["ready", "clear", "current", true, null]) {
      const forgedFact = { labelPreference: "prepaid-label", availability, revision: 7 } as never;
      await expect(
        read(facts({ labelPreferences: [forgedFact], providerRoutes: [forgedFact] })),
      ).resolves.toMatchObject({ label: labelBlocked("unavailable"), provider: providerBlocked("unavailable") });
    }
    const statusBesideUnavailable = {
      labelPreference: "prepaid-label",
      availability: "unavailable",
      revision: 7,
      status: "ready",
    } as never;
    await expect(read(facts({ labelPreferences: [statusBesideUnavailable] }))).resolves.toMatchObject({
      label: labelBlocked("unavailable"),
    });
  });

  it("transports no credentials, cookies or raw provider payloads from the facts it reads", async () => {
    const withSecrets = {
      ...facts(),
      providerPayload: { rateId: "rate_raw_payload" },
      credential: "provider-credential-value",
      cookie: "session-cookie-value",
    } as SellerCheckoutReadinessFacts;
    const serialized = JSON.stringify(await read(withSecrets));
    for (const secret of ["rate_raw_payload", "provider-credential-value", "session-cookie-value", "tcgplayer"]) {
      expect(serialized.toLowerCase()).not.toContain(secret);
    }
  });

  it("keeps the Checkout reasons and the label readiness copy it maps to", () => {
    const boundary = matrix.checkoutAdapterBoundary;
    expect(unionMembers(repoSource(boundary.consumer), boundary.consumerReasonType)).toEqual(
      expect.arrayContaining(["ready", "label-not-ready", "provider-not-ready"]),
    );
    expect(matrix.dimensions.map((dimension) => dimension.blockedReason)).toEqual([
      "label-not-ready",
      "provider-not-ready",
    ]);
    expect(checkoutEnglishTranslations["checkout.routes.sellCheckoutSession.validation.label.failed"]).toBe(
      "Label readiness is unavailable. Refresh the Sell List before seller checkout.",
    );
  });
});
