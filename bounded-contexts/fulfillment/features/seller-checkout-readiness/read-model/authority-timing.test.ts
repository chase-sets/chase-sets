import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  SellerCheckoutReadinessKey,
  SellerCheckoutReadinessOwner,
  SellerCheckoutReadinessReader,
  SellerCheckoutReadinessResult,
} from "../domain/contract";
import {
  readSellerCheckoutReadiness,
  type SellerCheckoutReadinessFacts,
  type SellerCheckoutReadinessFactSource,
} from "./queries";

const probePath = fileURLToPath(
  new URL("../../../../../artifacts/10769/tests/authority-timing-probe.json", import.meta.url),
);

type Moment = "readiness" | "before-confirm";
type Rejection = "owner-key-changed" | "not-ready" | "revision-drift";

type ProbeEntry = Readonly<{
  moment: Moment;
  owner: SellerCheckoutReadinessOwner;
  shipFromLocationId: string;
  labelPreference: SellerCheckoutReadinessKey["labelPreference"];
  sourceRevision: number | null;
  sourceTimestamp: string | null;
  label: SellerCheckoutReadinessResult["label"];
  provider: SellerCheckoutReadinessResult["provider"];
}>;

type ScenarioRun = Readonly<{
  scenario: string;
  probe: readonly ProbeEntry[];
  outcome: "confirmed" | "rejected";
  rejection: Rejection | null;
  steps: readonly string[];
}>;

const sellerAccountId: AccountId = "acc_01JSELLER000000000000000000";
const shipFromLocationId = "sfl_01JLOCATION000000000000000";
const accountOwner: SellerCheckoutReadinessOwner = { kind: "account", accountId: sellerAccountId };
const anonymousOwner: SellerCheckoutReadinessOwner = {
  kind: "anonymous",
  anonymousSellListId: "anon_01JGUEST00000000000000000",
};
const keyFor = (owner: SellerCheckoutReadinessOwner): SellerCheckoutReadinessKey => ({
  owner,
  shipFromLocationId,
  labelPreference: "prepaid-label",
});

function ownerKey(owner: SellerCheckoutReadinessOwner) {
  return owner.kind === "account" ? `account:${owner.accountId}` : `anonymous:${owner.anonymousSellListId}`;
}

function readyFacts(owner: SellerCheckoutReadinessOwner, revision: number): SellerCheckoutReadinessFacts {
  return {
    owner,
    shipFromLocationId,
    revision,
    recordedAt: "2026-10-29T14:00:00.000Z",
    mergedIntoAccountId: null,
    labelPreferences: [{ labelPreference: "prepaid-label", availability: "available", revision }],
    providerRoutes: [{ labelPreference: "prepaid-label", availability: "available", revision }],
  };
}

/** Owner facts in memory: one record per owner and Ship-From Location, revised the way Fulfillment would. */
function createFactStore(initial: SellerCheckoutReadinessFacts) {
  const records = new Map<string, SellerCheckoutReadinessFacts>();
  const scope = (owner: SellerCheckoutReadinessOwner) => `${ownerKey(owner)}|${shipFromLocationId}`;
  const put = (record: SellerCheckoutReadinessFacts) => records.set(scope(record.owner), record);
  put(initial);

  const source: SellerCheckoutReadinessFactSource = async (key) => records.get(scope(key.owner)) ?? null;

  function revise(owner: SellerCheckoutReadinessOwner, recordedAt: string, mergedIntoAccountId: AccountId | null) {
    const current = records.get(scope(owner));
    if (!current) {
      throw new Error(`No facts to revise for ${ownerKey(owner)}`);
    }
    const revision = current.revision + 1;
    const revised = {
      ...current,
      revision,
      recordedAt,
      mergedIntoAccountId,
      labelPreferences: current.labelPreferences.map((fact) => ({ ...fact, revision })),
      providerRoutes: current.providerRoutes.map((fact) => ({ ...fact, revision })),
    };
    put(revised);
    return revised;
  }

  function mergeIntoAccount(accountId: AccountId, recordedAt: string) {
    const invalidated = revise(anonymousOwner, recordedAt, accountId);
    put({ ...invalidated, owner: { kind: "account", accountId }, mergedIntoAccountId: null });
  }

  return { source, revise, mergeIntoAccount };
}

function confirmRejection(readiness: ProbeEntry, beforeConfirm: ProbeEntry): Rejection | null {
  if (
    ownerKey(readiness.owner) !== ownerKey(beforeConfirm.owner) ||
    readiness.shipFromLocationId !== beforeConfirm.shipFromLocationId ||
    readiness.labelPreference !== beforeConfirm.labelPreference
  ) {
    return "owner-key-changed";
  }
  if (beforeConfirm.label.status !== "ready" || beforeConfirm.provider.status !== "ready") {
    return "not-ready";
  }
  if (readiness.sourceRevision === null || readiness.sourceRevision !== beforeConfirm.sourceRevision) {
    return "revision-drift";
  }
  return null;
}

/**
 * Stands in for Checkout's adapter: it reads at the readiness request, re-reads
 * immediately before the confirm request, and runs the confirm side effect only
 * when both reads name the same owner key and revision and are still ready.
 */
async function runConfirmFlow(params: {
  scenario: string;
  reader: SellerCheckoutReadinessReader;
  readinessKey: SellerCheckoutReadinessKey;
  confirmKey: SellerCheckoutReadinessKey;
  betweenMoments: () => void;
}): Promise<ScenarioRun> {
  const steps: string[] = [];
  const probe: ProbeEntry[] = [];
  async function capture(moment: Moment, key: SellerCheckoutReadinessKey) {
    const result = await params.reader(key);
    steps.push(`read:${moment}`);
    const entry: ProbeEntry = {
      moment,
      owner: key.owner,
      shipFromLocationId: key.shipFromLocationId,
      labelPreference: key.labelPreference,
      sourceRevision: result.sourceRevision,
      sourceTimestamp: result.sourceTimestamp,
      label: result.label,
      provider: result.provider,
    };
    probe.push(entry);
    return entry;
  }

  const readiness = await capture("readiness", params.readinessKey);
  params.betweenMoments();
  const beforeConfirm = await capture("before-confirm", params.confirmKey);
  const rejection = confirmRejection(readiness, beforeConfirm);
  if (!rejection) {
    steps.push("side-effect:confirm");
  }
  return { scenario: params.scenario, probe, outcome: rejection ? "rejected" : "confirmed", rejection, steps };
}

function scenario(
  name: string,
  initial: SellerCheckoutReadinessFacts,
  keys: Readonly<{ readiness: SellerCheckoutReadinessKey; confirm: SellerCheckoutReadinessKey }>,
  betweenMoments: (store: ReturnType<typeof createFactStore>) => void,
) {
  const store = createFactStore(initial);
  const reader: SellerCheckoutReadinessReader = (key) => readSellerCheckoutReadiness(store.source, key);
  return runConfirmFlow({
    scenario: name,
    reader,
    readinessKey: keys.readiness,
    confirmKey: keys.confirm,
    betweenMoments: () => betweenMoments(store),
  });
}

const sameAccount = { readiness: keyFor(accountOwner), confirm: keyFor(accountOwner) };
const sameAnonymous = { readiness: keyFor(anonymousOwner), confirm: keyFor(anonymousOwner) };

describe("seller checkout readiness timing harness", () => {
  let runs: Record<"unchanged" | "revisionDrift" | "ownerKeyChanged" | "mergedBeforeConfirm", ScenarioRun>;
  let probe: Readonly<{ runId: string; scenarios: readonly ScenarioRun[] }>;

  beforeAll(async () => {
    runs = {
      unchanged: await scenario("unchanged", readyFacts(accountOwner, 7), sameAccount, () => {}),
      revisionDrift: await scenario("revision-drift", readyFacts(accountOwner, 7), sameAccount, (store) => {
        store.revise(accountOwner, "2026-10-29T14:01:00.000Z", null);
      }),
      ownerKeyChanged: await scenario(
        "owner-key-changed",
        readyFacts(anonymousOwner, 3),
        { readiness: keyFor(anonymousOwner), confirm: keyFor(accountOwner) },
        (store) => store.mergeIntoAccount(sellerAccountId, "2026-10-29T14:02:00.000Z"),
      ),
      mergedBeforeConfirm: await scenario(
        "merged-before-confirm",
        readyFacts(anonymousOwner, 3),
        sameAnonymous,
        (store) => store.mergeIntoAccount(sellerAccountId, "2026-10-29T14:02:00.000Z"),
      ),
    };
    probe = {
      runId: randomUUID(),
      scenarios: Object.values(runs),
    };
    mkdirSync(path.dirname(probePath), { recursive: true });
    writeFileSync(
      probePath,
      `${JSON.stringify(
        {
          schemaVersion: "fulfillment.seller-checkout-readiness-timing-probe.v1",
          generatedAt: new Date().toISOString(),
          ...probe,
        },
        null,
        2,
      )}\n`,
    );
  });

  it("reads the same owner key at readiness and immediately before confirm and confirms an unchanged revision", () => {
    const [readiness, beforeConfirm] = runs.unchanged.probe;
    expect(runs.unchanged.probe.map((entry) => entry.moment)).toEqual(["readiness", "before-confirm"]);
    expect(beforeConfirm).toEqual({ ...readiness, moment: "before-confirm" });
    expect(readiness).toMatchObject({
      owner: accountOwner,
      sourceRevision: 7,
      sourceTimestamp: "2026-10-29T14:00:00.000Z",
      label: { status: "ready", reason: "ready" },
      provider: { status: "ready", reason: "ready" },
    });
    expect(runs.unchanged).toMatchObject({ outcome: "confirmed", rejection: null });
    expect(runs.unchanged.steps).toEqual(["read:readiness", "read:before-confirm", "side-effect:confirm"]);
  });

  it("rejects a mutated revision before any side effect", () => {
    const [readiness, beforeConfirm] = runs.revisionDrift.probe;
    expect([readiness.sourceRevision, beforeConfirm.sourceRevision]).toEqual([7, 8]);
    expect(beforeConfirm).toMatchObject({
      owner: accountOwner,
      sourceTimestamp: "2026-10-29T14:01:00.000Z",
      label: { status: "ready" },
      provider: { status: "ready" },
    });
    expect(runs.revisionDrift).toMatchObject({ outcome: "rejected", rejection: "revision-drift" });
    expect(runs.revisionDrift.steps).toEqual(["read:readiness", "read:before-confirm"]);
  });

  it("rejects an owner key that changed between the moments before any side effect", () => {
    const [readiness, beforeConfirm] = runs.ownerKeyChanged.probe;
    expect([readiness.owner, beforeConfirm.owner]).toEqual([anonymousOwner, accountOwner]);
    expect(beforeConfirm).toMatchObject({
      sourceRevision: 4,
      label: { status: "ready" },
      provider: { status: "ready" },
    });
    expect(runs.ownerKeyChanged).toMatchObject({ outcome: "rejected", rejection: "owner-key-changed" });
    expect(runs.ownerKeyChanged.steps).toEqual(["read:readiness", "read:before-confirm"]);
  });

  it("rejects anonymous facts a merge invalidated between the moments before any side effect", () => {
    const [readiness, beforeConfirm] = runs.mergedBeforeConfirm.probe;
    expect(readiness).toMatchObject({ owner: anonymousOwner, sourceRevision: 3, label: { status: "ready" } });
    expect(beforeConfirm).toMatchObject({
      owner: anonymousOwner,
      sourceRevision: 4,
      label: { status: "blocked", reason: "label-not-ready", fact: "stale" },
      provider: { status: "blocked", reason: "provider-not-ready", fact: "stale" },
    });
    expect(runs.mergedBeforeConfirm).toMatchObject({ outcome: "rejected", rejection: "not-ready" });
    expect(runs.mergedBeforeConfirm.steps).toEqual(["read:readiness", "read:before-confirm"]);
  });

  it("writes the bounded probe this run generated rather than a replayed one", () => {
    const written = JSON.parse(readFileSync(probePath, "utf8")) as typeof probe;
    expect(written.runId).toBe(probe.runId);
    expect(written.scenarios).toEqual(JSON.parse(JSON.stringify(probe.scenarios)));
    expect(written.scenarios.map((run) => run.probe.map((entry) => entry.moment))).toEqual(
      Array.from({ length: 4 }, () => ["readiness", "before-confirm"]),
    );
  });
});
