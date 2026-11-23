import { describe, expect, it, vi } from "vitest";
import { createMarketplaceApiClient } from "../../../client";
import { completedMarketplaceAttemptSchema, hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { marketplaceMutationRecoveryResultSchema } from "../../mutation-recovery/domain/contracts";
import { authorizationResultSchema, type AuthorizationResult, type PaymentSource } from "../domain/contracts";
import { buildInstrumentProjection } from "../integrations/payments/instrument-projection";
import { createOfferPaymentAuthorizationRoutes } from "./route";
import {
  balance,
  bank,
  card,
  activatePolicy,
  context,
  fixture,
  identity,
  instrument,
  nextPublication,
  path,
  post,
  publication,
  snapshot,
  withActor,
} from "../tests/fixtures";

const kind = "offer-payment-authorization.command";
const buyerId = context.audit.forAccountId;
const authorizationId = `marketplace.offer-payment-authorization-${buyerId}`;
const commands = `${path}/commands`;

async function expectError(response: Response, code: string, status = 409) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: { code } });
}

async function prepare(f: ReturnType<typeof fixture>, source: PaymentSource, version = 0) {
  const response = await f.app.request(commands, post({ ...identity(version), type: "preview", source }));
  expect(response.status, await response.clone().text()).toBe(200);
  const preview = authorizationResultSchema.parse(await response.json());
  return {
    ...identity(preview.version),
    type: "authorize" as const,
    previewId: preview.preview!.previewId,
    consent: true,
  };
}

async function projectInstruments(f: ReturnType<typeof fixture>) {
  const handlers = buildInstrumentProjection(async () => {});
  await handlers["payments.checkout-affordances-published"]!(
    snapshot(1, [
      instrument(),
      instrument(bank.instrumentId, "bank-account"),
      instrument("pending", "card", "setup-required"),
    ]),
    { db: f.db },
  );
}

describe("Offer Payment Authorization account routes", () => {
  it.each([card, bank, balance, { ...card, useBalance: true }])(
    "authorizes only the previewed own source: %j",
    async (source) => {
      const f = fixture();
      await f.activate();
      await projectInstruments(f);
      const response = await f.app.request(commands, post(await prepare(f, source)));
      expect(response.status).toBe(200);
      await f.project();
      const own = await f.app.request(path);
      expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({
        authorizationId,
        state: "active",
        generation: 1,
        consentVersion: publication.version,
        source: {
          ...source,
          displayLabel: source.instrumentId ? `Label ${source.instrumentId}` : null,
          category: source.instrumentId === bank.instrumentId ? "bank-account" : source.instrumentId ? "card" : null,
        },
        eligibleInstruments: [{ instrumentId: bank.instrumentId }, { instrumentId: card.instrumentId }],
        policyActivation: { version: publication.version },
      });
    },
  );

  it("rejects unusable sources, missing consent, stale Preview and inactive policy", async () => {
    const f = fixture();
    await projectInstruments(f);
    const preview = (source: PaymentSource) =>
      f.app.request(commands, post({ ...identity(0), type: "preview", source }));
    await expectError(await preview(balance), "offer_payment_consent_not_approved");
    await f.activate();
    f.instruments.set("acc_foreign", [
      {
        instrument_id: "foreign",
        category: "card",
        readiness: "ready",
        checkout_eligible: true,
        display_label: "Foreign instrument",
        removed_at: null,
      },
    ]);
    for (const source of [
      { useBalance: false, instrumentId: null },
      { ...card, instrumentId: "pending" },
      { ...card, instrumentId: "foreign" },
    ])
      await expectError(await preview(source), "invalid_payment_source");
    const valid = await prepare(f, card);
    await expectError(
      await f.app.request(commands, post({ ...valid, consent: undefined })),
      "offer_payment_consent_not_approved",
    );
    await expectError(await f.app.request(commands, post({ ...valid, expectedVersion: 0 })), "stale_preview");
    await expectError(await f.app.request(commands, post({ ...valid, previewId: "0".repeat(64) })), "stale_preview");
    await projectInstrumentsBeforeAuthorize(f);
    await expectError(await f.app.request(commands, post(valid)), "invalid_payment_source");
  });

  it("rejects an Authorize if activation advances between its authority read and append", async () => {
    const f = fixture();
    await activatePolicy(f.app, f.policies, publication, context, false);
    await expectError(
      await f.app.request(
        commands,
        post({ ...identity(0), type: "authorize", consent: true, previewId: "0".repeat(64) }),
      ),
      "offer_payment_consent_not_approved",
    );
    await f.activate();
    const command = await prepare(f, balance);
    const before = await f.store.readStream({ streamId: authorizationId });
    const append = f.store.appendToStreams!;
    vi.spyOn(f.store, "appendToStreams").mockImplementationOnce(async (inputs) => {
      await activatePolicy(f.app, f.policies, nextPublication);
      return append(inputs);
    });
    await expectError(await f.app.request(commands, post(command)), "stale_preview");
    expect(await f.store.readStream({ streamId: authorizationId })).toEqual(before);
    const recovery = await f.app.request(recoveryPath(command, buyerId));
    expect(recovery.status).toBe(200);
    expect(await recovery.json()).toMatchObject({ ownerStatus: "not-observed" });
  });

  it("validates a Resume source, retains consent, and fences concurrent Hold by generation", async () => {
    const f = fixture();
    await f.activate();
    await projectInstruments(f);
    expect((await f.app.request(commands, post(await prepare(f, card)))).status).toBe(200);
    await f.runtime.markPaymentMethodUnavailable(1, card.instrumentId, context);
    const events = () => f.store.readStream({ streamId: authorizationId });
    const expectedVersion = (await events()).at(-1)!.streamVersion;
    await expectError(
      await f.app.request(
        commands,
        post({ ...identity(expectedVersion), type: "resume", source: { ...card, instrumentId: "pending" } }),
      ),
      "invalid_payment_source",
    );
    const append = f.store.appendToStreams!;
    vi.spyOn(f.store, "appendToStreams").mockImplementationOnce(async (inputs) => {
      await f.runtime.holdForFailedPayment("ord_won", 1, context);
      return append(inputs);
    });
    const resume = { ...identity(expectedVersion), type: "resume", source: bank };
    await expectError(await f.app.request(commands, post(resume)), "stale_preview");
    const response = await f.app.request(
      commands,
      post({ ...resume, ...identity((await events()).at(-1)!.streamVersion) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "active",
      generation: 2,
      source: bank,
      consentVersion: publication.version,
    });
    const resumed = await events();
    await f.runtime.holdForFailedPayment("ord_won", 2, context);
    await f.runtime.holdForFailedPayment("ord_stale", 1, context);
    expect(await events()).toEqual(resumed);
  });

  it("hides foreign existing and nonexistent recovery targets with the same 404 and leaves own missing unobserved", async () => {
    const f = fixture();
    await f.activate();
    const command = await prepare(f, balance);
    expect((await f.app.request(commands, post(command))).status).toBe(200);
    await f.project();
    const foreign = withActor({ ...context, audit: { ...context.audit, forAccountId: "acc_foreign" as never } });
    foreign.route(path, createOfferPaymentAuthorizationRoutes(f.runtime));
    expect(await (await foreign.request(path)).json()).toMatchObject({ state: "none", source: null });
    expect((await foreign.request(commands, post(command))).status).toBe(409);
    for (const target of ["acc_foreign", "acc_does_not_exist"]) {
      if (target === "acc_foreign") {
        await f.runtime.markRequired({ ...context, audit: { ...context.audit, forAccountId: target as never } });
      }
      await expectError(await f.app.request(recoveryPath(command, target)), "not_found", 404);
    }
    const missing = await f.app.request(recoveryPath({ ...command, ...identity(command.expectedVersion) }, buyerId));
    expect(missing.status).toBe(200);
    expect(marketplaceMutationRecoveryResultSchema.parse(await missing.json())).toMatchObject({
      ownerStatus: "not-observed",
    });
  });

  it("recovers a lost response by exact retry and replays the immutable result for both IDs", async () => {
    const f = fixture();
    await f.activate();
    const command = await prepare(f, balance);
    let accepted: AuthorizationResult | undefined;
    let sends = 0;
    const client = createMarketplaceApiClient({
      baseUrl: "http://marketplace.test",
      fetch: async (url, init) => {
        const requested = new URL(String(url));
        if (requested.pathname !== commands) expect(requested.pathname).toMatch(/^\/mutation-attempts\//);
        const response = await f.app.request(requested, init);
        if (requested.pathname === commands && sends++ === 0) {
          expect(response.status).toBe(200);
          accepted = authorizationResultSchema.parse(await response.json());
          expect((await f.app.request(commands, post({ ...identity(accepted.version), type: "revoke" }))).status).toBe(
            200,
          );
          throw new TypeError("response lost after commit");
        }
        return response;
      },
    });
    const first = await client.commandOfferPaymentAuthorization(buyerId, command);
    expect(sends).toBe(2);
    expect(first).toEqual(accepted);
    const committedResponse = await f.app.request(recoveryPath(command, buyerId));
    const recovery = marketplaceMutationRecoveryResultSchema.parse(await committedResponse.json());
    expect(recovery).toMatchObject({
      ownerStatus: "committed",
      ownerReceipt: { id: authorizationId, version: first.version },
    });
    expect(recovery).not.toHaveProperty("result");
    const completed = completedMarketplaceAttemptSchema(authorizationResultSchema);
    expect(completed.safeParse({ recovery, result: first }).success).toBe(true);
    for (const receipt of [
      { id: buyerId, version: first.version },
      { id: authorizationId, version: first.version + 1 },
    ]) {
      expect(completed.safeParse({ recovery: { ...recovery, ownerReceipt: receipt }, result: first }).success).toBe(
        false,
      );
    }
    const freshAttempt = { ...command, attemptId: identity(0).attemptId };
    const replay = await f.app.request(commands, post(freshAttempt));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    const observed = await (await f.app.request(recoveryPath(freshAttempt, buyerId))).json();
    expect(observed.ownerReceipt).toEqual(recovery.ownerReceipt);
    await expectError(await f.app.request(commands, post({ ...command, consent: false })), "attempt_conflict");
    await expectError(
      await f.app.request(commands, post({ ...command, attemptId: identity(0).attemptId, consent: false })),
      "operation_conflict",
    );
    expect(
      (await f.store.readStream({ streamId: authorizationId })).filter((event) =>
        event.eventType.endsWith(".authorized"),
      ),
    ).toHaveLength(1);
    await f.project();
    expect(await (await f.app.request(path)).json()).toMatchObject({ state: "revoked", generation: 1 });
  });
});

function recoveryPath({ attemptId, ...input }: { attemptId: string }, target: string) {
  return `/mutation-attempts/${attemptId}?${new URLSearchParams({ kind, target, requestHash: hashMarketplaceRequest(input) })}`;
}

async function projectInstrumentsBeforeAuthorize(f: ReturnType<typeof fixture>) {
  await buildInstrumentProjection(async () => {})["payments.checkout-affordances-published"]!(snapshot(2, []), {
    db: f.db,
  });
}
