import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as http from "@chase-sets/platform-runtime/http";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import * as transport from "../../source-observations/api/providers/count-capture-transport";
import { sendCatalogProviderRequest } from "../../source-observations/api/providers/provider-send-admission";
import * as acquisition from "../domain/count-acquisition";
import * as plan from "../domain/count-capture-plan";
import * as receipt from "../domain/count-lifecycle-receipt";
import { countCaptureUnitKeys } from "../domain/count-capture-plan";
import { guardDisabledMutant } from "../tests/count-capture-mutants";
import {
  captureActor,
  captureAt,
  captureAuthority,
  captureRoster,
  captureScope,
  captureSession,
  createCaptureLifecycleFixture,
} from "../tests/count-capture-session-fixture";
import * as storeModule from "../read-model/count-capture-store";
import { countCaptureSessionOwner } from "./count-capture-lifecycle";
import * as lifecycleModule from "./count-capture-lifecycle";

const input = () => ({ scopeRecordId: captureScope, authority: captureAuthority() });
const runs = (f: ReturnType<typeof createCaptureLifecycleFixture>) =>
  [...new Set(f.memory.history.map((entry) => entry.run_id))].map(
    (runId) => f.memory.history.filter((entry) => entry.run_id === runId).at(-1)!.payload as { status: string },
  );

describe("capture admission", () => {
  it("admits one bounded run", async () => {
    const f = createCaptureLifecycleFixture();
    const result = await f.lifecycle.baseline(captureSession(), input());
    expect(result.baseline.selection).toEqual({
      scopeRecordId: captureScope,
      scopeRecordVersion: "2026-10-13T07:00:00.000Z",
      accountRevision: "runtime",
      productDomain: "one-piece",
      parentValue: "OP01",
      languageCode: "en",
    });
    // The full roster: exactly the three Scrydex units, in order, with their revisions.
    expect(result.baseline.units).toEqual(
      countCaptureUnitKeys.map((unitKey, index) => ({
        unitKey,
        profileKey: captureRoster().profiles[index]!.profileKey,
        profileVersion: "2026.06.22",
        mappingId: `mapping-synthetic-${index}`,
        mappingVersion: "2026-10-13T07:00:00.000Z",
        setCoordinate: "OP01",
      })),
    );
    expect(result.baseline.countAuthority).toMatchObject({ headroom: 30, allowed: true });
    expect(result.baseline.effects).toEqual({
      at: captureAt,
      batches: 2,
      reservations: 0,
      jobs: 5,
      enqueues: 1,
      imports: 7,
    });
    expect(result.access).toEqual({
      originHost: "admin.staging.chasesets.com",
      role: "platform-admin",
      permissions: ["catalog.view", "catalog.manage"],
      ownerMatch: true,
      checkedAt: captureAt,
    });
    // The host declared these deployment facts; the server validated, never observed, them.
    expect(result.host).toMatchObject({
      dispatchId: "synthetic-dispatch",
      runnerSha: "a".repeat(40),
      deployment: { runId: "100", jobId: "200" },
      netCredits: 25,
    });
    expect(result.providerSends).toBe(0);
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(f.readRoster).toHaveBeenCalledExactlyOnceWith(captureScope);
    // One open run, its baseline phase finished and recorded; no run identity leaves the server.
    expect(runs(f)).toEqual([expect.objectContaining({ status: "open", phases: ["baseline"], request: null })]);
    expect(JSON.stringify(result)).not.toContain((runs(f)[0] as unknown as { runId: string }).runId);
  });

  type Refusal = Readonly<{
    session?: Parameters<typeof captureSession>[0];
    environment?: string;
    input?: () => Readonly<{ scopeRecordId: string; authority: unknown }>;
    roster?: () => ReturnType<typeof captureRoster>;
    // `admitted` refusals stop a run they admitted; the others admit nothing.
    admitted?: boolean;
  }>;
  const stale = () => ({ ...input(), authority: { ...captureAuthority(), dispatchedAt: "2026-10-13T07:40:00.000Z" } });
  const refusals: Record<string, Refusal> = {
    "an invalid envelope": { input: () => ({ ...input(), authority: { ...captureAuthority(), budget: undefined } }) },
    "a stale envelope": { input: stale },
    "a non-staging environment": { environment: "production" },
    "a missing permission": { session: { actor: captureActor({ permissions: ["catalog.view"] }) } },
    "a missing view permission": { session: { actor: captureActor({ permissions: ["catalog.manage"] }) } },
    "a non-admin role": { session: { actor: captureActor({ roleKey: "seller" }) } },
    "no session": { session: { actor: null } },
    "a foreign origin": { session: { origin: "https://foreign.invalid" } },
    "a foreign public origin": { session: { url: "https://admin.chasesets.com/api/catalog/x" } },
    "a cross-site request": { session: { site: "cross-site" } },
    "a non-POST request": { session: { method: "PUT" } },
    "an agent grant": {
      session: { actor: captureActor({ agentGrant: { grantId: "synthetic-grant" } as never }) },
    },
    "a session for another account": { session: { actor: captureActor({ accountId: "acc_other" }) } },
    "a third Scrydex set unit": {
      admitted: true,
      roster: () => {
        const roster = captureRoster();
        return {
          ...roster,
          mappings: [
            ...roster.mappings,
            { ...roster.mappings[0]!, mapping_id: "m-third", unit_key: "scrydex:one-piece:third-set:reference-data" },
          ],
        };
      },
    },
    "an omitted unit": {
      admitted: true,
      roster: () => ({ ...captureRoster(), mappings: captureRoster().mappings.slice(0, 2) }),
    },
    "another provider's unit": {
      admitted: true,
      roster: () => ({
        ...captureRoster(),
        mappings: [
          ...captureRoster().mappings.slice(0, 2),
          { ...captureRoster().mappings[2]!, provider_key: "tcgdex" },
        ],
      }),
    },
    "a unit mapped to another set": {
      admitted: true,
      roster: () => ({
        ...captureRoster(),
        mappings: captureRoster().mappings.map((mapping, index) => (index ? mapping : { ...mapping, set_id: "OP02" })),
      }),
    },
    "a unit without one active profile": {
      admitted: true,
      roster: () => ({ ...captureRoster(), profiles: captureRoster().profiles.slice(1) }),
    },
    "an inactive scope": {
      admitted: true,
      roster: () => ({
        ...captureRoster(),
        records: [{ ...captureRoster().records[0]!, lifecycle_status: "retired" }],
      }),
    },
  };
  it.each(Object.keys(refusals))("refuses %s with zero provider I/O", async (name) => {
    const refusal = refusals[name]!;
    const f = createCaptureLifecycleFixture({ environment: refusal.environment, roster: refusal.roster });
    await expect(f.lifecycle.baseline(captureSession(refusal.session), (refusal.input ?? input)())).rejects.toThrow(
      CountCaptureStopped,
    );
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(runs(f)).toEqual(refusal.admitted ? [expect.objectContaining({ status: "stopped", baseline: null })] : []);
  });

  it("refuses an unknown provider send category during the egress-denied baseline", async () => {
    const roster = captureRoster();
    const f = createCaptureLifecycleFixture({
      roster: async () => {
        await sendCatalogProviderRequest(
          "scrydex",
          f.usage.fetch,
          "https://api.scrydex.com/onepiece/v1/expansions",
          undefined,
          "discovery",
        );
        return roster;
      },
    });
    await expect(f.lifecycle.baseline(captureSession(), input())).rejects.toThrow(CountCaptureStopped);
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(runs(f)).toEqual([expect.objectContaining({ status: "stopped", sends: [] })]);
  });

  it("refuses a second active run and a replayed dispatch, from any session", async () => {
    const f = createCaptureLifecycleFixture();
    await f.lifecycle.baseline(captureSession(), input());
    const other = captureSession({ actor: captureActor({ sessionId: "synthetic-other-session" }) });
    await expect(
      f.lifecycle.baseline(other, { ...input(), authority: { ...captureAuthority(), dispatchId: "synthetic-next" } }),
    ).rejects.toThrow(CountCaptureStopped);
    await expect(f.lifecycle.baseline(captureSession(), input())).rejects.toThrow(CountCaptureStopped);
    // The first run is untouched by both refusals.
    expect(runs(f)).toEqual([expect.objectContaining({ status: "open" })]);
    // After it expires, a new dispatch admits, but the consumed dispatch never does.
    f.clock.now = "2026-10-13T08:17:00.000Z";
    const fresh = (dispatchId: string) => ({
      ...input(),
      authority: {
        ...captureAuthority(),
        dispatchId,
        dispatchedAt: "2026-10-13T08:10:00.000Z",
        budget: { ...captureAuthority().budget, observedAt: "2026-10-13T08:10:00.000Z" },
        pods: { ...captureAuthority().pods, observedAt: "2026-10-13T08:11:00.000Z" },
        collection: receiptCollection("2026-10-13T08:12:00.000Z"),
      },
    });
    await expect(f.lifecycle.baseline(captureSession(), fresh("synthetic-dispatch"))).rejects.toThrow(
      CountCaptureStopped,
    );
    await expect(f.lifecycle.baseline(captureSession(), fresh("synthetic-next"))).resolves.toMatchObject({
      host: { dispatchId: "synthetic-next" },
    });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });

  it("derives the run owner from the authenticated session alone", () => {
    const owner = countCaptureSessionOwner(captureSession(), "staging");
    expect(owner).toMatch(/^[a-f0-9]{64}$/);
    expect(countCaptureSessionOwner(captureSession(), "staging")).toBe(owner);
    expect(
      countCaptureSessionOwner(captureSession({ actor: captureActor({ sessionId: "synthetic-other" }) }), "staging"),
    ).not.toBe(owner);
  });
});

function receiptCollection(collectedAt: string) {
  return { ...captureAuthority().collection, collectedAt };
}

// Original #9520 AC6 floor: each owned guard, disabled alone, admits its hostile case.
describe("guard-disabled bypass mutants", () => {
  const sessionBindings = { z, ...plan, ...receipt, ...http, ...transport, ...acquisition };
  const sessionGuards = {
    staging: ['environment !== "staging"', "a non-staging environment"],
    session: ["!actor || !actor.sessionId", "no session"],
    "agent grant": ["actor.agentGrant", "an agent grant"],
    role: ['actor.roleKey !== "platform-admin"', "a non-admin role"],
    permission: ['!actor.permissions.includes("catalog.manage")', "a missing permission"],
    "view permission": ['!actor.permissions.includes("catalog.view")', "a missing view permission"],
    owner: ["actor.accountId !== context.audit.forAccountId", "a session for another account"],
    method: ['request.method !== "POST"', "a non-POST request"],
    origin: ['request.headers.get("origin") !== countCaptureAdminOrigin', "a foreign origin"],
    "public origin": ["resolvePublicRequestOrigin(request) !== countCaptureAdminOrigin", "a foreign public origin"],
    "cross-site": ['request.headers.get("sec-fetch-site") === "cross-site"', "a cross-site request"],
  } as const;
  it.each(Object.entries(sessionGuards))("the %s guard", (_name, [needle, hostile]) => {
    const refusal = refusalSessions[hostile]!;
    const real = () => countCaptureSessionOwner(captureSession(refusal.session), refusal.environment ?? "staging");
    expect(real).toThrow(CountCaptureStopped);
    const mutant = guardDisabledMutant<typeof countCaptureSessionOwner>(
      "../api/count-capture-lifecycle.ts",
      [needle, "false"],
      "countCaptureSessionOwner",
      sessionBindings,
    );
    expect(mutant(captureSession(refusal.session), refusal.environment ?? "staging")).toMatch(/^[a-f0-9]{64}$/);
  });

  const lifecycleGuards = {
    envelope: ["!validateCountCaptureAuthority(input.authority, at).ok", { input: "stale" }],
    "roster size": ["roster.mappings.length !== countCaptureUnitKeys.length", { roster: "third" }],
    "roster unit": ['mapping.set_id === "OP01"', { roster: "other-set", replacement: "true" }],
  } as const;
  it.each(Object.entries(lifecycleGuards))("the %s guard", async (_name, [needle, hostile]) => {
    const roster =
      "roster" in hostile
        ? hostile.roster === "third"
          ? () => {
              const base = captureRoster();
              return {
                ...base,
                mappings: [
                  ...base.mappings,
                  {
                    ...base.mappings[0]!,
                    mapping_id: "m-third",
                    unit_key: "scrydex:one-piece:third-set:reference-data",
                  },
                ],
              };
            }
          : () => ({
              ...captureRoster(),
              mappings: captureRoster().mappings.map((mapping, index) =>
                index ? mapping : { ...mapping, set_id: "OP02" },
              ),
            })
        : undefined;
    const body =
      "input" in hostile
        ? { ...input(), authority: { ...captureAuthority(), dispatchedAt: "2026-10-13T07:40:00.000Z" } }
        : input();
    const real = createCaptureLifecycleFixture({ roster });
    await expect(real.lifecycle.baseline(captureSession(), body)).rejects.toThrow(CountCaptureStopped);
    const f = createCaptureLifecycleFixture({ roster });
    const create = guardDisabledMutant<typeof lifecycleModule.createCountCaptureLifecycle>(
      "../api/count-capture-lifecycle.ts",
      [needle, "replacement" in hostile ? hostile.replacement : "false"],
      "createCountCaptureLifecycle",
      { z, ...http, ...transport, ...acquisition, ...plan, ...receipt, ...storeModule },
    );
    const mutant = create({ ...f.deps });
    await expect(mutant.baseline(captureSession(), body)).resolves.toMatchObject({ providerSends: 0 });
  });
});

const refusalSessions: Record<string, { session?: Parameters<typeof captureSession>[0]; environment?: string }> = {
  "a non-staging environment": { environment: "production" },
  "no session": { session: { actor: captureActor({ sessionId: "" }) } },
  "an agent grant": { session: { actor: captureActor({ agentGrant: { grantId: "synthetic-grant" } as never }) } },
  "a non-admin role": { session: { actor: captureActor({ roleKey: "seller" }) } },
  "a missing permission": { session: { actor: captureActor({ permissions: ["catalog.view"] }) } },
  "a missing view permission": { session: { actor: captureActor({ permissions: ["catalog.manage"] }) } },
  "a session for another account": { session: { actor: captureActor({ accountId: "acc_other" }) } },
  "a non-POST request": { session: { method: "PUT" } },
  "a foreign origin": { session: { origin: "https://foreign.invalid" } },
  "a foreign public origin": { session: { url: "https://admin.chasesets.com/api/catalog/x" } },
  "a cross-site request": { session: { site: "cross-site" } },
};
