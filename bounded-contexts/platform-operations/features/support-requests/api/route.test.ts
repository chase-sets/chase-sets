// @vitest-environment node
import { Hono } from "hono";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SupportApiEnv } from "./http";
import { createAccountSupportRequestRoutes } from "./route";
import {
  projectSupportFlow,
  type SupportFlowDetail,
  type SupportParticipantAction,
  type SupportParticipantPolicy,
} from "./support-flow-projection";
import type { SupportRequestDetailResponse, SupportRequestParticipantDetailResponse } from "../ui/contracts";
import type {
  SupportOperationsRequestDetailRow,
  SupportOperationsRequestListRow,
  SupportRequestDetailRow,
} from "../read-model/queries";
import type { SupportRequesterRole } from "../domain/common";
import type { SupportRequestServices } from "./runtime";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { createSupportAttachmentReferenceLifecycle, createSupportRequestRuntime } from "./runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { decideSupportRequest, initialSupportRequestState } from "../domain/domain";
import { guestCheckoutActorThroughAuth, mintEvidenceActorThroughIdentity } from "../tests/evidence-access-identity";
import {
  multipartRequest,
  nativeFormData,
  openingPhotoForm,
  streamedIntakeRequest,
} from "../tests/attachment-intake.test-support";
import { SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES, SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS } from "./attachment-intake";
import { canonicalParticipantRequest } from "../domain/participant-attempt";
import {
  canonicalizeSupportEvidenceImage,
  createSupportEvidenceCanonicalizationQueue,
} from "./evidence-canonicalization";
import {
  attachmentManifestReferences,
  attachmentOperationStreamId,
  createAttachmentManifest,
} from "../domain/attachment-operation";
import { createSupportEvidenceSeedContext } from "../domain/common";
import { parseSupportEvidenceCleanupBinding } from "./attachment-cleanup";
import { getSupportFlowDefinition, type SupportFlowDefinition } from "../domain/flow-catalog";
import { createRemedyExecution } from "../domain/remedy";
import { createRemedyApprovalWorkflow } from "../domain/remedy-approval";
import {
  participantFixture,
  buyer,
  attemptId,
  requestHash,
  operationsResponseFixture,
  responseCases,
  responseFixture,
  responseSeller,
} from "./participant-attempt.test-support";
import { participantOpenSupportRequestId } from "./participant-runtime";

describe("participant intake staging route", () => {
  const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const open = { orderId: "ord_attempt", flowType: "product-damaged", affectedLineIds: ["line_a"] };
  function fixture(uncertain = false) {
    const f = participantFixture();
    const keys = new Set<string>();
    const storage = {
      putPrivate: vi.fn(async (input: { key: string }) => {
        if (uncertain) return { status: "ambiguous" as const, key: input.key, reason: "transport-failed" as const };
        keys.add(input.key);
        return { status: "completed" as const, key: input.key };
      }),
      verifyPrivate: vi.fn(async (key: string) => ({
        status: keys.has(key) ? ("match" as const) : ("absent" as const),
      })),
      readPrivate: vi.fn(),
    };
    const runtime = createSupportRequestRuntime({
      eventStore: f.eventStore,
      db: f.db as never,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      attachmentStorage: storage,
      attachmentCanonicalizer: createSupportEvidenceCanonicalizationQueue({
        canonicalize: canonicalizeSupportEvidenceImage,
      }),
    });
    return { ...f, runtime, storage, app: attachmentApp(runtime, buyer) };
  }
  async function stage(app: ReturnType<typeof attachmentApp>, override: Record<string, string | null> = {}) {
    const form = await nativeFormData();
    const values = { ...open, affectedLineIds: "line_a", attemptId, ...override };
    for (const [key, value] of Object.entries(values)) if (value !== null) form.set(key, value);
    form.append(
      "attachments",
      new File(
        [readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg")],
        "photo.jpg",
        { type: "image/jpeg" },
      ),
    );
    return app.request(
      await multipartRequest(`http://localhost/support-requests/participant-attempts/${attemptId}/attachments`, form, {
        "x-support-attachment-operation-id": operationId,
      }),
    );
  }
  it("stages and opens a whole-order request when multipart omits affected line ids", async () => {
    const f = fixture();
    const staged = await stage(f.app, { affectedLineIds: null });
    expect(staged.status).toBe(201);
    const attachments = (await staged.json()).attachments;
    const body = {
      orderId: open.orderId,
      flowType: open.flowType,
      intakePhotoReferences: attachments.map((item: { reference: string }) => item.reference),
      attachmentOperationId: operationId,
    };
    const response = await f.app.request("/support-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": attemptId,
        "X-Support-Request-Hash": requestHash("open-support-request", body),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: "opened", evidenceId: expect.stringMatching(/^sev_/) });
    expect(
      f.allEvents.find((event) => event.eventType === "support.support-request.affected-line-items-recorded")?.payload,
    ).toMatchObject({
      affectedLineItems: [
        { lineId: "line_a", amount: "12.00", currencyCode: "usd" },
        { lineId: "line_b", amount: "12.00", currencyCode: "usd" },
      ],
    });
    expect(
      f.allEvents.find((event) => event.eventType === "support.support-request.evidence-submitted")?.payload,
    ).toMatchObject({ evidence: { attachments: body.intakePhotoReferences } });
  });
  it("stages without opening, binds the complete batch to order/flow/lines/attempt and atomically opens with evidence", async () => {
    const f = fixture();
    const staged = await stage(f.app);
    expect(staged.status).toBe(201);
    const attachments = (await staged.json()).attachments;
    expect(attachments).toHaveLength(1);
    const id = participantOpenSupportRequestId(buyer.tenantId, buyer.accountId, attemptId);
    expect(f.allEvents.some((event) => event.streamId === `support.support-request-${id}`)).toBe(false);
    const replay = await stage(f.app);
    expect(replay.status).toBe(201);
    expect((await replay.json()).attachments).toEqual(attachments);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    expect((await stage(f.app, { affectedLineIds: "line_b" })).status).toBe(400);
    const body = {
      ...open,
      intakePhotoReferences: attachments.map((item: { reference: string }) => item.reference),
      attachmentOperationId: operationId,
      photoRequired: false,
      openedByRole: "seller",
    };
    const response = await f.app.request("/support-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": attemptId,
        "X-Support-Request-Hash": requestHash("open-support-request", body),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id, status: "opened", evidenceId: expect.stringMatching(/^sev_/) });
    expect(
      f.allEvents.filter((event) => event.streamId === `support.support-request-${id}`).map((event) => event.eventType),
    ).toEqual(
      expect.arrayContaining([
        "support.support-request.opened",
        "support.support-request.evidence-submitted",
        "support.support-request.participant-attempt-recorded",
      ]),
    );
  });
  it("uncertain storage returns no references and cannot open or re-put on retry", async () => {
    const f = fixture(true);
    const first = await stage(f.app);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("support-attachment:v1:");
    expect((await stage(f.app)).status).toBe(503);
    expect(f.storage.putPrivate).toHaveBeenCalledTimes(1);
    expect(f.allEvents.filter((event) => event.eventType === "support.support-request.opened")).toEqual([]);
  });
  it("missing authority, foreign order owner and mismatched multipart attempt refuse before storage", async () => {
    const f = fixture();
    expect((await stage(attachmentApp(f.runtime, null))).status).toBe(401);
    expect((await stage(attachmentApp(f.runtime, { ...buyer, accountId: "acc_other" }))).status).toBe(404);
    expect((await stage(f.app, { attemptId: `${attemptId}_other` })).status).toBe(400);
    expect(f.storage.putPrivate).not.toHaveBeenCalled();
  });
});

describe("customer list authority", () => {
  const terms = {
    factSchemaVersion: 1 as const,
    supportRequestId: "sup_1",
    remedyId: "rmd_1",
    coverageId: "cov_1",
    remedy: { kind: "full-refund" as const, amount: "125.00", currencyCode: "usd" },
    allocation: {
      sellerFundedAmount: "0.00",
      platformFundedAmount: "125.00",
      currencyCode: "usd",
      fundingKind: "platform-funded" as const,
    },
    returnDirective: "return-to-platform" as const,
    refundTrigger: "facility-intake" as const,
    reasonCode: "insufficient-evidence",
    idempotencyKey: "rmd_1:authorized",
    causationId: null,
    policyVersion: "platform-remedy-2026-07",
    occurredAt: "2026-07-14T12:00:00.000Z",
  };
  const execution = createRemedyExecution(terms);
  const approval = createRemedyApprovalWorkflow({
    type: "ProposeSupportRemedy",
    terms,
    proposedByAccountId: "acc_operator",
    permissionUsed: "support.remedies.propose",
    rationale: "Existing evidence",
    evidenceReferences: ["evidence:1"],
    reservationExpiresAt: "2099-07-15T12:00:00.000Z",
    requiredApprovalCount: 1,
    requiresElevatedApproval: false,
    returnOverrideUsed: false,
    returnExceptionReasonCode: null,
  });
  const effects = (changes: Readonly<Record<string, string>>) => ({
    ...execution,
    effects: [
      ...execution.effects,
      ...Object.keys(changes)
        .filter((name) => !execution.effects.some((effect) => effect.effect === name))
        .map((name) => ({ ...execution.effects[0]!, effect: name as (typeof execution.effects)[number]["effect"] })),
    ].map((effect) => ({ ...effect, status: (changes[effect.effect] ?? effect.status) as typeof effect.status })),
  });
  const cases = [
    [null, null, null],
    [null, { ...approval, status: "approval-pending" }, "proposed-under-review"],
    [null, approval, "awaiting-coverage-approval"],
    [null, { ...approval, status: "expired" }, "expired-deadline"],
    [null, { ...approval, status: "reservation-rejected" }, "manual-review"],
    [null, { ...approval, status: "correction-requested" }, "manual-review"],
    [execution, null, "resolution-in-progress"],
    [effects({ "return-label-available": "satisfied" }), null, "return-label-ready"],
    [effects({ "carrier-accepted": "waived", "return-delivered": "pending" }), null, "in-transit"],
    [effects({ "return-delivered": "satisfied" }), null, "awaiting-intake"],
    [{ ...execution, refundReleasedAt: "2026-07-15T00:00:00.000Z" }, null, "refund-submitted"],
    [effects({ "refund-completion": "satisfied" }), null, "refund-confirmed"],
    [effects({ "refund-completion": "failed-terminal" }), null, "refund-failure"],
    [effects({ "return-label-available": "failed-retryable" }), null, "carrier-exception"],
    [effects({ "coverage-reservation": "failed-retryable" }), null, "manual-review"],
    [{ ...execution, status: "completed" }, null, "completed"],
  ] as const;
  for (const role of ["buyer", "seller"] as const) {
    it.each(cases)(
      `${role} list projects state %s / %s as %s without browser authority`,
      async (remedy, workflow, expected) => {
        const rows = [0, 1].map((index) => ({
          ...supportRequestDetail(),
          support_request_id: `sup_${index}`,
          remedy,
          remedy_approval: workflow,
          seller_response_due_at: "2026-07-20T00:00:00.000Z",
          support_review_due_at: "2026-07-18T00:00:00.000Z",
          seller_condition_attestation_due_at: "2026-07-17T00:00:00.000Z",
        }));
        const query = vi.fn(async (sql: string) => ({ rows: sql.includes("COUNT(*)") ? [{ count: "102" }] : rows }));
        const memory = createInMemoryEventStore();
        const runtime = createSupportRequestRuntime({
          eventStore: memory.eventStore,
          db: { query } as never,
          checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
        });
        const response = await buildApp(runtime, ["support.view"], `acc_${role}`).request(
          `/support-requests/${role === "buyer" ? "purchases" : "sales"}?limit=2&offset=100&role=${role === "buyer" ? "seller" : "buyer"}`,
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({ total: 102, count: 2 });
        expect(body.items).toHaveLength(2);
        for (const [index, row] of body.items.entries()) {
          expect(row).toMatchObject({ ...rows[index], nextDeadline: "2026-07-20T00:00:00.000Z" });
          const state =
            expected === "refund-confirmed" && role === "seller" ? "settlement-reconciliation-pending" : expected;
          if (state === null) expect(row.customerRemedyStatus).toBeNull();
          else
            expect(row.customerRemedyStatus).toMatchObject({
              state,
              role,
              terminal: state === "completed",
              amount: "125.00",
              platformAmount: "125.00",
              sellerAmount: "0.00",
              returnDirective: "return-to-platform",
              refundTrigger: "facility-intake",
            });
        }
        expect(query.mock.calls.some((call) => call[0].includes(`WHERE ${role}_account_id = $1`))).toBe(true);
        expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT $2 OFFSET $3"), [`acc_${role}`, 2, 100]);
      },
    );
    it.each([
      [null, null, null, null],
      ["2026-07-20", null, null, "2026-07-20"],
      [null, "2026-07-18", null, "2026-07-18"],
      [null, null, "2026-07-17", "2026-07-17"],
    ])(`${role} list deadline null/one: %s %s %s`, async (seller, support, condition, nextDeadline) => {
      const memory = createInMemoryEventStore();
      const row = {
        ...supportRequestDetail(),
        remedy: null,
        remedy_approval: null,
        seller_response_due_at: seller,
        support_review_due_at: support,
        seller_condition_attestation_due_at: condition,
      };
      const runtime = createSupportRequestRuntime({
        eventStore: memory.eventStore,
        db: {
          query: vi.fn(async (sql: string) => ({ rows: sql.includes("COUNT(*)") ? [{ count: "1" }] : [row] })),
        } as never,
        checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      });
      const response = await buildApp(runtime, ["support.view"], `acc_${role}`).request(
        `/support-requests/${role === "buyer" ? "purchases" : "sales"}`,
      );
      expect((await response.json()).items[0]).toMatchObject({ nextDeadline, customerRemedyStatus: null });
    });
  }
});

function evidenceActorContext(actor: ResolvedActor): EventStoreContext {
  return {
    tenantId: parseTypedId(actor.tenantId, "tnt"),
    audit: { performedByUserId: parseTypedId(actor.userId, "usr"), forAccountId: parseTypedId(actor.accountId, "acc") },
  };
}

it.each(responseCases.filter((entry) => entry.resolutionType !== null))(
  "participant response derives resolution after hashing: $responseType",
  async (scenario) => {
    for (const field of [
      { offerResolutionType: scenario.resolutionType },
      {},
      { offerResolutionType: null },
      { offerResolutionType: "" },
    ]) {
      const fixture = await responseFixture(scenario.responseType, "Offer");
      fixture.setActor(responseSeller);
      const body = { ...fixture.body, ...field };
      const response = await fixture.app.request(`/support-requests/${fixture.id}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `${attemptId}_route_derived`,
          "X-Support-Request-Hash": requestHash("record-response", body),
        },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      const history = await readCompleteStream(fixture.eventStore, {
        streamId: `support.support-request-${fixture.id}`,
      });
      expect(history.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer).toMatchObject({
        responseType: scenario.responseType,
        resolutionType: scenario.resolutionType,
      });
    }
  },
);

describe("operations response preservation", () => {
  for (const scenario of responseCases) {
    for (const field of [{}, { offerResolutionType: null }, { offerResolutionType: 42 }, { offerResolutionType: "" }]) {
      const empty = field.offerResolutionType === "";
      it(`${empty ? "operations empty resolution remains refused" : "operations offer omission remains refused"}: ${scenario.responseType} ${JSON.stringify(field)}`, async () => {
        const f = await operationsResponseFixture(scenario.responseType, "Offer");
        f.db.query.mockResolvedValue({
          rows: [{ support_request_id: f.id, flow_type: scenario.flowType, status: "open", resolution: null }],
        } as never);
        const before = f.allEvents.length;
        const response = await f.app.request(`/support-requests/ops/${f.id}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...f.body, ...field }),
        });
        if (scenario.resolutionType || empty) {
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            error: { code: "validation_failed", message: "Support resolution type is not supported." },
          });
          expect(f.allEvents).toHaveLength(before);
        } else {
          expect(response.status).toBe(200);
          expect(f.allEvents.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer).toBeNull();
        }
      });
    }
    if (scenario.resolutionType) {
      it(`operations explicit offer remains supported: ${scenario.responseType}`, async () => {
        const f = await operationsResponseFixture(scenario.responseType, "Offer");
        f.db.query.mockResolvedValue({
          rows: [{ support_request_id: f.id, flow_type: scenario.flowType, status: "open", resolution: null }],
        } as never);
        const response = await f.app.request(`/support-requests/ops/${f.id}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...f.body, offerResolutionType: scenario.resolutionType }),
        });
        expect(response.status).toBe(200);
        expect(
          f.allEvents.find((event) => event.eventType.endsWith(".response-recorded"))?.payload.offer,
        ).toMatchObject({ resolutionType: scenario.resolutionType, offeredByRole: "support" });
      });
    }
  }
});

describe("Support evidence submissions use one reference boundary", () => {
  const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const context = {
    tenantId: "tnt_identity",
    audit: { performedByUserId: "usr_buyer", forAccountId: "acc_buyer" },
  } as never;
  async function batch(fixture: Awaited<ReturnType<typeof attachmentRouteFixture>>, scenario = "complete") {
    const owner = {
      tenantId: "tnt_identity",
      accountId: scenario === "foreign" ? "acc_other" : "acc_buyer",
      supportRequestId: scenario === "other-case" ? "sup_other" : "sup_case",
      operationId,
    };
    const manifest = createAttachmentManifest({
      owner,
      profile: "support-evidence-raster/v1",
      encoderFingerprint: {
        profile: "support-evidence-raster/v1",
        sharp: "test",
        libvips: "test",
        platform: "test",
        arch: "test",
        libc: "test",
      },
      images: ["a", "b"].map((hash) => ({ canonicalSha256: hash.repeat(64), contentType: "image/jpeg", byteSize: 10 })),
    });
    await fixture.eventStore.appendToStream({
      streamId: attachmentOperationStreamId(owner),
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "support.attachment-operation.staged", payload: manifest },
        ...(scenario === "unstored"
          ? []
          : manifest.items.map((item) => ({
              eventType: "support.attachment-operation.stored",
              payload: { index: item.index },
            }))),
      ],
    });
    return attachmentManifestReferences(manifest).slice(0, scenario === "partial-batch" ? 1 : 2);
  }
  for (const operations of [false, true]) {
    for (const scenario of [
      "foreign",
      "other-case",
      "partial-batch",
      "unstored",
      "arbitrary",
      "non-seed-placeholder",
      "bare-reference",
    ] as const) {
      it(`rejects ${scenario} on ${operations ? "operations" : "participant"} route with zero product appends (mutant: skip claimed complete batch grammar)`, async () => {
        const fixture = await attachmentRouteFixture();
        const attachments =
          scenario === "arbitrary"
            ? ["https://example.test/photo"]
            : scenario === "non-seed-placeholder"
              ? ["seed://support/photo"]
              : await batch(fixture, scenario);
        const before = fixture.allEvents.filter(
          (event) => !event.streamId.startsWith("support.evidence-access-"),
        ).length;
        const actor = evidenceActor("owner", ["support.manage"], operations, "acc_buyer");
        const response = await attachmentApp(fixture.runtime, actor).request(
          `/support-requests/${operations ? "ops/" : ""}sup_case/evidence`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              evidenceType: "photo",
              summary: "Evidence",
              attachments,
              ...(scenario === "bare-reference" || scenario === "arbitrary" || scenario === "non-seed-placeholder"
                ? {}
                : { attachmentOperationId: operationId }),
            }),
          },
        );
        expect(response.status, await response.clone().text()).toBe(400);
        expect((await response.json()).error.code).toBe("attachment_reference_unknown");
        if (!operations) {
          const body = {
            evidenceType: "photo",
            summary: "Evidence",
            attachments,
            ...(scenario === "bare-reference" || scenario === "arbitrary" || scenario === "non-seed-placeholder"
              ? {}
              : { attachmentOperationId: operationId }),
          };
          let requestHash = "a".repeat(64);
          try {
            requestHash = createHash("sha256")
              .update(canonicalParticipantRequest("submit-evidence", body))
              .digest("hex");
          } catch {
            /* invalid reference grammar must also reject direct runtime dispatch */
          }
          await expect(
            fixture.runtime.executeParticipantAttempt(
              {
                actionKind: "submit-evidence",
                targetId: "sup_case",
                accountId: actor.accountId,
                actor,
                body,
                attempt: { attemptId: "9391_direct_boundary_0123456789", requestHash },
              },
              evidenceActorContext(actor),
            ),
          ).rejects.toThrow("attachment_reference_unknown");
        }
        expect(
          fixture.allEvents.filter((event) => !event.streamId.startsWith("support.evidence-access-")),
        ).toHaveLength(before);
      });
    }
  }
  it("runtime and direct command reject bare or forged references; seed placeholders require actual seed context (mutant: sibling runtime or seed bypass)", async () => {
    const fixture = await attachmentRouteFixture();
    const actor = evidenceActor("owner", ["support.manage"], false, "acc_buyer");
    const actorContext = evidenceActorContext(actor);
    for (const attachments of [["arbitrary"], ["seed://support/photo"], await batch(fixture)]) {
      const before = fixture.allEvents.filter((event) => !event.streamId.startsWith("support.evidence-access-")).length;
      await expect(
        fixture.runtime.submitEvidence(
          {
            supportRequestId: "sup_case",
            accountId: "acc_buyer",
            submittedByRole: "buyer",
            actor,
            evidenceType: "photo",
            summary: "Evidence",
            attachments,
          },
          actorContext,
        ),
      ).rejects.toThrow("attachment_reference_unknown");
      await expect(
        fixture.runtime.commandHandler({
          streamId: "support.support-request-sup_case",
          context: actorContext,
          command: {
            type: "SubmitSupportEvidence",
            evidenceId: "sev_direct",
            submittedByRole: "buyer",
            evidenceType: "photo",
            summary: "Evidence",
            submittedAt: "2026-10-13T00:00:00.000Z",
            attachments,
          },
        }),
      ).rejects.toThrow("attachment_reference_unknown");
      expect(fixture.allEvents.filter((event) => !event.streamId.startsWith("support.evidence-access-"))).toHaveLength(
        before,
      );
    }
    await fixture.runtime.commandHandler({
      streamId: "support.support-request-sup_case",
      context: createSupportEvidenceSeedContext(actorContext),
      command: {
        type: "SubmitSupportEvidence",
        evidenceId: "sev_seed",
        submittedByRole: "buyer",
        evidenceType: "photo",
        summary: "Seed evidence",
        submittedAt: "2026-10-13T00:00:00.000Z",
        attachments: ["seed://support/photo"],
      },
    });
  });
  it("complete claimed batches pass and retry recovers confirmation without duplicate evidence; history references need no operation", async () => {
    const fixture = await attachmentRouteFixture();
    const attachments = await batch(fixture);
    const actor = evidenceActor("owner", ["support.manage"], false, "acc_buyer");
    const app = attachmentApp(fixture.runtime, actor);
    const body = { evidenceType: "photo", summary: "Evidence", attachments, attachmentOperationId: operationId };
    for (let retry = 0; retry < 2; retry++) {
      const response = await app.request("/support-requests/sup_case/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(
      fixture.allEvents.filter((event) => event.eventType === "support.attachment-operation.reference-claimed"),
    ).toHaveLength(1);
    expect(
      fixture.allEvents.filter((event) => event.eventType === "support.attachment-operation.referenced"),
    ).toHaveLength(1);
    const response = await app.request("/support-requests/sup_case/evidence", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "9391_history_reference_0123456789" },
      body: JSON.stringify({ ...body, attachmentOperationId: undefined }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
  });
  it.each([false, true])(
    "preserves authorized %s operations evidence on a case with legacy seed audit tenants (mutant: treat case audit tenant as access authority)",
    async (operations) => {
      for (const freshBatch of [false, true]) {
        const fixture = await attachmentRouteFixture(true, "acc_buyer", "tnt_seed_development");
        const attachments = freshBatch ? await batch(fixture) : [fixture.reference];
        const response = await attachmentApp(
          fixture.runtime,
          evidenceActor("owner", ["support.manage"], operations, "acc_buyer"),
        ).request(`/support-requests/${operations ? "ops/" : ""}sup_case/evidence`, {
          method: "POST",
          body: JSON.stringify({
            evidenceType: "photo",
            summary: "Evidence",
            attachments,
            ...(freshBatch ? { attachmentOperationId: operationId } : {}),
          }),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        if (freshBatch)
          expect(
            fixture.allEvents.filter((event) => event.eventType === "support.attachment-operation.referenced"),
          ).toHaveLength(1);
      }
    },
  );
  it("participant delayed reference is rejected with no evidence or receipt append (mutant: omit empty operation guard or serial fallback)", async () => {
    const fixture = await attachmentRouteFixture();
    const attachments = await batch(fixture);
    const append = fixture.eventStore.appendToStreams!.bind(fixture.eventStore);
    vi.spyOn(fixture.eventStore, "appendToStreams").mockImplementation(async (inputs) => {
      if (
        inputs.some((input) =>
          input.events.some((event) => event.eventType === "support.support-request.evidence-submitted"),
        )
      )
        await createSupportAttachmentReferenceLifecycle(fixture.eventStore).release(
          {
            owner: { tenantId: "tnt_identity", accountId: "acc_buyer", supportRequestId: "sup_case", operationId },
            expectedVersion: 4,
          },
          context,
        );
      return append(inputs);
    });
    const response = await attachmentApp(
      fixture.runtime,
      evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
    ).request("/support-requests/sup_case/evidence", {
      method: "POST",
      body: JSON.stringify({
        evidenceType: "photo",
        summary: "Evidence",
        attachments,
        attachmentOperationId: operationId,
      }),
    });
    expect(response.status).toBe(409);
    expect(fixture.allEvents.filter((event) => event.streamId === "support.support-request-sup_case")).toHaveLength(2);
    expect(
      fixture.allEvents.some((event) => event.eventType === "support.support-request.participant-attempt-recorded"),
    ).toBe(false);
  });
  it("participant replay after restart confirms the committed batch once (mutant: receipt replay bypasses confirmation)", async () => {
    const fixture = await attachmentRouteFixture();
    const attachments = await batch(fixture);
    const body = { evidenceType: "photo", summary: "Evidence", attachments, attachmentOperationId: operationId };
    const actor = evidenceActor("owner", ["support.manage"], false, "acc_buyer");
    const append = fixture.eventStore.appendToStreams!.bind(fixture.eventStore);
    const interruption = vi.spyOn(fixture.eventStore, "appendToStreams").mockImplementation(async (inputs) => {
      if (
        inputs.some((input) =>
          input.events.some((event) => event.eventType === "support.attachment-operation.referenced"),
        )
      )
        throw new Error("confirmation interrupted");
      return append(inputs);
    });
    const first = await attachmentApp(fixture.runtime, actor).request("/support-requests/sup_case/evidence", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(503);
    interruption.mockRestore();
    const restarted = createSupportRequestRuntime({
      eventStore: fixture.eventStore,
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    });
    for (let retry = 0; retry < 2; retry++) {
      const response = await attachmentApp(restarted, actor).request("/support-requests/sup_case/evidence", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    expect(
      fixture.allEvents.filter((event) => event.eventType === "support.attachment-operation.referenced"),
    ).toHaveLength(1);
    expect(
      fixture.allEvents.filter((event) => event.eventType === "support.support-request.participant-attempt-recorded"),
    ).toHaveLength(1);
    expect(
      fixture.allEvents.filter((event) => event.eventType === "support.support-request.evidence-submitted"),
    ).toHaveLength(2);
  });
});

const participantReference = `support-attachment:v1:sea_photo:${"a".repeat(64)}:jpg`;

function buildApp(
  services: SupportRequestServices,
  permissions: readonly string[] = [
    "support.manage",
    "support.remedies.propose",
    "support.remedies.approve",
    "support.remedies.override-return",
    "support.remedies.retry",
    "support.remedies.waive",
    "support.remedies.correct",
  ],
  accountId = "acc_operator",
) {
  const app = new Hono<SupportApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", evidenceActor("platform-admin", permissions, false, accountId));
    c.set("context", {
      tenantId: "tnt_identity",
      audit: { performedByUserId: "usr_operator", forAccountId: accountId },
    } as never);
    await next();
  });

  app.route("/support-requests", createAccountSupportRequestRoutes(services));

  return app;
}

describe("support attachment capability x role x participation", () => {
  it("accepts five real file parts and ordinary hidden/text fields with a valid operation header", async () => {
    const fixture = await attachmentRouteFixture();
    const form = await openingPhotoForm(0);
    // A text field that looks like file metadata is still not a file part.
    form.append('note; filename="not-a-file"', "ordinary text");
    const photo = readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg");
    for (let index = 0; index < 5; index++)
      form.append("attachments", new File([photo], `${index}.jpg`, { type: "image/jpeg" }));
    const request = await multipartRequest("http://localhost/support-requests/sup_case/attachments", form, {
      "x-support-attachment-operation-id": "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    const response = await attachmentApp(
      fixture.runtime,
      evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
    ).request(request);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).attachments).toHaveLength(5);
    expect(fixture.storage.putPrivate).toHaveBeenCalledTimes(5);
  });
  for (const scenario of ["declared-over", "stream-over", "cap", "stalled"] as const) {
    it(`bounds API intake ${scenario} with zero storage calls`, async () => {
      const fixture = await attachmentRouteFixture();
      const cap = SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES;
      const request = streamedIntakeRequest(
        "http://localhost/support-requests/sup_case/attachments",
        scenario === "stream-over" ? cap + 1 : cap,
        scenario === "declared-over" ? cap + 1 : cap,
        scenario === "stalled",
      );
      request.headers.set("x-support-attachment-operation-id", "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      const parse = vi.spyOn(Response.prototype, "formData");
      if (scenario === "stalled") vi.useFakeTimers();
      try {
        const pending = attachmentApp(
          fixture.runtime,
          evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
        ).request(request);
        if (scenario === "stalled") await vi.advanceTimersByTimeAsync(SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS);
        const response = await pending;
        expect(response.status).toBe(scenario === "stalled" ? 408 : scenario === "cap" ? 400 : 413);
        expect(parse).toHaveBeenCalledTimes(scenario === "cap" ? 1 : 0);
        expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
        expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
      } finally {
        parse.mockRestore();
        vi.useRealTimers();
      }
    });
  }

  it("rejects file six at its streamed part headers, without reading its body", async () => {
    const fixture = await attachmentRouteFixture();
    const encoded = await multipartRequest(
      "http://localhost/support-requests/sup_case/attachments",
      await openingPhotoForm(6),
      { "x-support-attachment-operation-id": "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    );
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    const end = text.indexOf("\r\n\r\n", text.indexOf('filename="5.jpg"')) + 4;
    let cancelled = false;
    const request = new Request(encoded.url, {
      method: "POST",
      headers: encoded.headers,
      duplex: "half",
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes.slice(0, end));
        },
        cancel() {
          cancelled = true;
        },
      }),
    } as RequestInit);
    const parse = vi.spyOn(Response.prototype, "formData");
    const decode = vi.spyOn(File.prototype, "arrayBuffer");
    try {
      const response = await attachmentApp(
        fixture.runtime,
        evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
      ).request(request);
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(parse).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
      expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
      decode.mockRestore();
    }
  });

  for (const header of [
    undefined,
    "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "sao_bad",
    "sao_81ARZ3NDEKTSV4RRFFQ69G5FAV",
    "",
  ] as const) {
    it(`requires operation header ${String(header)} after authorization, before parsing or operation staging`, async () => {
      const fixture = await attachmentRouteFixture();
      const request = await multipartRequest(
        "http://localhost/support-requests/sup_case/attachments",
        await openingPhotoForm(0),
        header === undefined ? {} : { "x-support-attachment-operation-id": header },
      );
      const parse = vi.spyOn(Response.prototype, "formData");
      try {
        const response = await attachmentApp(
          fixture.runtime,
          evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
        ).request(request);
        expect(response.status).toBe(400);
        expect(parse).toHaveBeenCalledTimes(header === "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV" ? 1 : 0);
        expect((await response.json()).error.code).toBe(
          header === "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV" ? "invalid-content" : "invalid-operation-id",
        );
        expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
        expect(fixture.storage.verifyPrivate).not.toHaveBeenCalled();
        expect(fixture.allEvents.filter((e) => e.streamId.startsWith("support.attachment-operation-"))).toHaveLength(0);
      } finally {
        parse.mockRestore();
      }
    });
  }
  it("rejects missing Content-Length before parsing or storage; kills after-parser bound mutant", async () => {
    const fixture = await attachmentRouteFixture();
    const request = new Request("http://localhost/support-requests/sup_case/attachments", {
      method: "POST",
      body: new URLSearchParams({ attachments: "photo" }),
      headers: { "x-support-attachment-operation-id": "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    const parse = vi.spyOn(request, "formData");
    const response = await attachmentApp(
      fixture.runtime,
      evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
    ).request(request);
    expect(response.status).toBe(411);
    expect(parse).not.toHaveBeenCalled();
    expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
  });
  for (const role of ["owner", "manager", "fulfillment", "viewer", "platform-admin"]) {
    for (const permitted of [false, true]) {
      for (const granted of [false, true]) {
        for (const participation of ["participant", "unrelated", "missing"] as const) {
          for (const action of ["upload", "download", "audit-read"] as const) {
            const mutant = !permitted
              ? "base-permission-bypass"
              : participation === "missing"
                ? "missing-case-bypass"
                : action === "audit-read" && !granted && participation === "participant"
                  ? "audit-participant-bypass"
                  : participation === "unrelated" && !granted
                    ? "participation-bypass"
                    : "grant-or-participant-refusal";
            it(`${action}: ${role}, base=${permitted}, grant=${granted}, ${participation}; kills ${mutant} mutant`, async () => {
              const fixture = await attachmentRouteFixture(participation !== "missing");
              const permission = action === "upload" ? "support.manage" : "support.view";
              const actor = evidenceActor(
                role,
                permitted ? [permission] : [],
                granted,
                participation === "participant" ? "acc_buyer" : "acc_unrelated",
              );
              const app = attachmentApp(fixture.runtime, actor);
              const request = new Request(
                `http://localhost/support-requests/${action === "audit-read" ? "ops/" : ""}sup_case/attachments${action === "download" ? "/sea_photo" : action === "audit-read" ? "/access-audit" : ""}`,
                {
                  method: action === "upload" ? "POST" : "GET",
                  ...(action === "upload"
                    ? { body: "invalid multipart marker", headers: { "content-type": "multipart/form-data" } }
                    : {}),
                },
              );
              const form = await nativeFormData();
              form.append(
                "attachments",
                new File(
                  [readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg")],
                  "photo.jpg",
                  { type: "image/jpeg" },
                ),
              );
              const intakeRequest =
                action === "upload"
                  ? await multipartRequest(request.url, form, {
                      "x-support-attachment-operation-id": "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                    })
                  : request;
              const parse = vi.spyOn(intakeRequest, "formData");
              const response = await app.request(intakeRequest);
              const status = !permitted
                ? 403
                : participation === "missing"
                  ? 404
                  : action === "audit-read"
                    ? granted
                      ? 200
                      : participation === "participant"
                        ? 403
                        : 404
                    : granted || participation === "participant"
                      ? action === "upload"
                        ? 201
                        : 200
                      : 404;
              expect(response.status).toBe(status);
              if (status >= 400) {
                expect(parse).not.toHaveBeenCalled();
                expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
                expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
              }
              expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(
                1,
              );
              expect(
                fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case").at(-1)?.payload,
              ).toMatchObject({
                decision: status >= 400 ? "denied" : "allowed",
                action,
              });
            });
          }
        }
      }
    }
  }

  it.each(["upload", "download", "audit-read"])(
    "%s signed out kills unauthenticated unrecorded-denial mutant",
    async (action) => {
      const fixture = await attachmentRouteFixture();
      const request = new Request(
        `http://localhost/support-requests/${action === "audit-read" ? "ops/" : ""}sup_case/attachments${action === "download" ? "/sea_photo" : action === "audit-read" ? "/access-audit" : ""}`,
        {
          method: action === "upload" ? "POST" : "GET",
          ...(action === "upload" ? { body: "unparsed" } : {}),
        },
      );
      const parse = vi.spyOn(request, "formData");
      expect((await attachmentApp(fixture.runtime, null).request(request)).status).toBe(401);
      expect(parse).not.toHaveBeenCalled();
      expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
      expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
      expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(1);
      expect(fixture.allEvents.at(-1)).toMatchObject({
        tenantId: "tnt_identity",
        payload: { tenantId: null, userId: null, accountId: null, membershipId: null },
      });
    },
  );

  it.each(["download", "upload", "audit-read"])(
    "%s guest checkout records one denied attempt without storage I/O or body parsing",
    async (action) => {
      const fixture = await attachmentRouteFixture();
      const actor = guestCheckoutActorThroughAuth("acc_buyer");
      const request = new Request(
        `http://localhost/support-requests/${action === "audit-read" ? "ops/" : ""}sup_case/attachments${action === "download" ? "/sea_photo" : action === "audit-read" ? "/access-audit" : ""}`,
        {
          method: action === "upload" ? "POST" : "GET",
          ...(action === "upload" ? { body: "unparsed" } : {}),
        },
      );
      const parse = vi.spyOn(request, "formData");
      const response = await attachmentApp(fixture.runtime, actor).request(request);
      const attempts = fixture.allEvents.filter((event) => event.streamId === "support.evidence-access-sup_case");
      expect.soft(response.status).toBe(403);
      expect.soft(attempts).toHaveLength(1);
      expect(await response.json()).toMatchObject({ error: { code: "authorization_forbidden" } });
      expect(attempts[0]?.payload).toMatchObject({
        decision: "denied",
        reason: "base-permission-required",
        membershipId: null,
        accountId: "acc_buyer",
        userId: "usr_guest_checkout",
      });
      expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
      expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it("downloads for principals minted and persisted by the real Identity API with one allowed attempt", async () => {
    const actor = await mintEvidenceActorThroughIdentity();
    const fixture = await attachmentRouteFixture(true, actor.accountId);
    const response = await attachmentApp(fixture.runtime, actor).request(
      "/support-requests/sup_case/attachments/sea_photo",
    );
    expect(response.status).toBe(200);
    const attempts = fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].payload).toMatchObject({
      decision: "allowed",
      membershipId: actor.membershipId,
      userId: actor.userId,
      accountId: actor.accountId,
    });
    expect(fixture.storage.readPrivate).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "nonempty %s operations submission preserves domain validation as 400 after one allowed attempt",
    async (operations) => {
      const fixture = await attachmentRouteFixture();
      const actor = evidenceActor("owner", ["support.manage"], operations);
      const response = await attachmentApp(fixture.runtime, actor).request(
        `/support-requests/${operations ? "ops/" : ""}sup_case/evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            submittedByRole: "buyer",
            evidenceType: "support-note",
            summary: "",
            attachments: [fixture.reference],
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
      const attempts = fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case");
      expect(attempts).toHaveLength(1);
      expect(attempts[0].payload).toMatchObject({ decision: "allowed" });
      expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
      expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "nonempty %s operations submission bounds unexpected failures as 503 after one allowed attempt",
    async (operations) => {
      const fixture = await attachmentRouteFixture();
      const append = fixture.eventStore.appendToStream.bind(fixture.eventStore);
      vi.spyOn(fixture.eventStore, "appendToStream").mockImplementation(async (input) => {
        if (input.streamId === "support.evidence-access-sup_case") return append(input);
        throw new Error("PLANTED_SUBMISSION_INFRASTRUCTURE_SECRET");
      });
      const response = await attachmentApp(
        fixture.runtime,
        evidenceActor("owner", ["support.manage"], operations),
      ).request(`/support-requests/${operations ? "ops/" : ""}sup_case/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          submittedByRole: "buyer",
          evidenceType: "support-note",
          summary: "Case evidence",
          attachments: [fixture.reference],
        }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "evidence_unavailable", message: "Support evidence is unavailable." },
      });
      const attempts = fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case");
      expect(attempts).toHaveLength(1);
      expect(attempts[0].payload).toMatchObject({ decision: "allowed" });
      expect(JSON.stringify(fixture.allEvents)).not.toContain("PLANTED_SUBMISSION_INFRASTRUCTURE_SECRET");
      expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
      expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
    },
  );

  for (const operations of [false, true]) {
    for (const permitted of [false, true])
      for (const granted of [false, true]) {
        for (const participant of [false, true]) {
          it(`nonempty references ${operations ? "operations" : "participant"}: base=${permitted}, grant=${granted}, participant=${participant}; kills submission-authority-bypass mutant`, async () => {
            const fixture = await attachmentRouteFixture();
            const actor = evidenceActor(
              "platform-admin",
              permitted ? ["support.manage"] : [],
              granted,
              participant ? "acc_buyer" : "acc_unrelated",
            );
            const response = await attachmentApp(fixture.runtime, actor).request(
              `/support-requests/${operations ? "ops/" : ""}sup_case/evidence`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  evidenceType: "support-note",
                  summary: "Case evidence",
                  attachments: [fixture.reference],
                }),
              },
            );
            expect(response.status).toBe(
              !permitted ? 403 : operations ? (granted ? 200 : participant ? 403 : 404) : participant ? 200 : 404,
            );
            expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(1);
            expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
            expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
          });
        }
      }
    it(`empty references preserve ${operations ? "operations" : "participant"} authorization without a grant or attempt`, async () => {
      const fixture = await attachmentRouteFixture();
      const response = await attachmentApp(
        fixture.runtime,
        evidenceActor("owner", ["support.manage"], false, operations ? "acc_unrelated" : "acc_buyer"),
      ).request(`/support-requests/${operations ? "ops/" : ""}sup_case/evidence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evidenceType: "support-note", summary: "Case note", attachments: [] }),
      });
      expect(response.status).toBe(200);
      expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(0);
    });
    it(`signed-out nonempty ${operations ? "operations" : "participant"} submission is durably denied`, async () => {
      const fixture = await attachmentRouteFixture();
      const response = await attachmentApp(fixture.runtime, null).request(
        `/support-requests/${operations ? "ops/" : ""}sup_case/evidence`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attachments: ["att_1"] }),
        },
      );
      expect(response.status).toBe(401);
      expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(1);
    });
  }

  it("grant revoke on next resolution returns to participant rules, never role fallback", async () => {
    const fixture = await attachmentRouteFixture();
    const granted = evidenceActor("platform-admin", ["support.view"], true, "acc_unrelated");
    expect(
      (await attachmentApp(fixture.runtime, granted).request("/support-requests/sup_case/attachments/sea_photo"))
        .status,
    ).toBe(200);
    const revoked = { ...granted, capabilityAssignments: [] };
    expect(
      (await attachmentApp(fixture.runtime, revoked).request("/support-requests/sup_case/attachments/sea_photo"))
        .status,
    ).toBe(404);
    expect(fixture.storage.readPrivate).toHaveBeenCalledTimes(1);
  });

  it("seller participation authorizes downloads but not audit reads without an assignment", async () => {
    const fixture = await attachmentRouteFixture();
    const app = attachmentApp(fixture.runtime, evidenceActor("viewer", ["support.view"], false, "acc_seller"));
    expect((await app.request("/support-requests/sup_case/attachments/sea_photo")).status).toBe(200);
    expect(fixture.allEvents.at(-1)?.payload).toMatchObject({ participation: "seller", reason: "participant" });
    expect((await app.request("/support-requests/ops/sup_case/attachments/access-audit")).status).toBe(403);
    expect(fixture.storage.readPrivate).toHaveBeenCalledTimes(1);
  });

  it("audit append failure kills unaudited-read and multipart-before-audit mutants", async () => {
    const fixture = await attachmentRouteFixture();
    vi.spyOn(fixture.eventStore, "appendToStream").mockRejectedValue(new Error("PLANTED_AUDIT_SECRET"));
    const actor = evidenceActor("owner", ["support.manage", "support.view"]);
    const request = new Request("http://localhost/support-requests/sup_case/attachments", {
      method: "POST",
      body: "unparsed",
    });
    const parse = vi.spyOn(request, "formData");
    expect((await attachmentApp(fixture.runtime, actor).request(request)).status).toBe(503);
    expect(parse).not.toHaveBeenCalled();
    const response = await attachmentApp(fixture.runtime, actor).request(
      "/support-requests/sup_case/attachments/sea_photo",
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("PLANTED_AUDIT_SECRET");
    expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
    expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
  });

  it("provider GET observes committed authorization; later failure cannot claim delivery or expose markers", async () => {
    const fixture = await attachmentRouteFixture();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.storage.readPrivate.mockImplementationOnce(async () => {
        const attempts = fixture.allEvents.filter((event) => event.streamId === "support.evidence-access-sup_case");
        expect(attempts).toHaveLength(1);
        expect(attempts[0].payload).toMatchObject({ decision: "allowed", action: "download" });
        throw new Error("PLANTED_PROVIDER_SECRET");
      });
      const response = await attachmentApp(fixture.runtime, evidenceActor("viewer", ["support.view"], true)).request(
        "/support-requests/sup_case/attachments/sea_photo",
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("PLANTED_PROVIDER_SECRET");
      expect(JSON.stringify(fixture.allEvents)).not.toContain("PLANTED_PROVIDER_SECRET");
      expect(JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])).not.toContain("PLANTED_PROVIDER_SECRET");
      expect(fixture.allEvents.filter((event) => event.streamId === "support.evidence-access-sup_case")).toHaveLength(
        1,
      );
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  });

  it("audit read records one nonrecursive attempt and cursor pages do not silently truncate", async () => {
    const fixture = await attachmentRouteFixture();
    const app = attachmentApp(fixture.runtime, evidenceActor("viewer", ["support.view"], true));
    for (let index = 0; index < 51; index++)
      expect((await app.request("/support-requests/sup_case/attachments/sea_photo")).status).toBe(200);
    const first = await app.request("/support-requests/ops/sup_case/attachments/access-audit");
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const page = await first.json();
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe("51");
    expect(fixture.allEvents.filter((event) => event.streamId === "support.evidence-access-sup_case")).toHaveLength(52);
    const tail = await (
      await app.request(`/support-requests/ops/sup_case/attachments/access-audit?cursor=${page.nextCursor}`)
    ).json();
    expect(tail.items).toHaveLength(3);
    expect(tail.nextCursor).toBeNull();
    expect(fixture.allEvents.filter((event) => event.payload.action === "audit-read")).toHaveLength(2);
  });

  it("complete authoritative state includes the decisive evidence beyond the 500-event page", async () => {
    const fixture = await attachmentRouteFixture();
    const lateReference = `support-attachment:v1:sea_late:${createHash("sha256")
      .update(new Uint8Array([0xff, 0xd8, 0xff]))
      .digest("hex")}:jpg`;
    await fixture.eventStore.appendToStream({
      streamId: "support.support-request-sup_case",
      expectedVersion: "any",
      context: {
        tenantId: "tnt_identity",
        audit: { performedByUserId: "usr_operator", forAccountId: "acc_buyer" },
      } as never,
      events: [
        ...Array.from({ length: 498 }, () => ({
          eventType: "support.support-request.affected-line-items-recorded",
          payload: { affectedLineItems: [] },
        })),
        {
          eventType: "support.support-request.evidence-submitted",
          payload: { evidence: { attachments: [lateReference] }, updatedChecklist: [] },
        },
      ],
    });
    const read = vi.spyOn(fixture.eventStore, "readStream");
    const response = await attachmentApp(fixture.runtime, evidenceActor("owner", ["support.view"])).request(
      "/support-requests/sup_case/attachments/sea_late",
    );
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledWith({ streamId: "support.support-request-sup_case", fromVersion: 501, limit: 500 });
  });

  it("authoritative stream gap is bounded unavailable, recorded, and never authorizes storage", async () => {
    const fixture = await attachmentRouteFixture();
    const original = fixture.eventStore.readStream;
    vi.spyOn(fixture.eventStore, "readStream").mockImplementation(async (input) =>
      (await original(input)).map((event) => ({ ...event, streamVersion: event.streamVersion + 1 })),
    );
    const response = await attachmentApp(fixture.runtime, evidenceActor("owner", ["support.view"])).request(
      "/support-requests/sup_case/attachments/sea_photo",
    );
    expect(response.status).toBe(503);
    expect(fixture.storage.readPrivate).not.toHaveBeenCalled();
    expect(fixture.allEvents.at(-1)?.payload).toMatchObject({ decision: "denied", reason: "authority-unavailable" });
  });

  it("malformed case ids return the same 404 unaudited with an unparsed upload", async () => {
    const fixture = await attachmentRouteFixture();
    const request = new Request("http://localhost/support-requests/not-a-case/attachments", {
      method: "POST",
      body: "PLANTED_SECRET",
    });
    const parse = vi.spyOn(request, "formData");
    expect((await attachmentApp(fixture.runtime, null).request(request)).status).toBe(404);
    expect(parse).not.toHaveBeenCalled();
    expect(fixture.storage.putPrivate).not.toHaveBeenCalled();
    expect(fixture.allEvents.filter((event) => event.streamId.startsWith("support.evidence-access-"))).toHaveLength(0);
  });
});

export function attachmentApp(runtime: SupportRequestServices, actor: ResolvedActor | null) {
  const app = new Hono<SupportApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    if (actor)
      c.set("context", {
        tenantId: actor.tenantId,
        audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
      } as never);
    if (c.req.method === "POST" && /\/support-requests\/[^/]+\/evidence$/.test(new URL(c.req.url).pathname)) {
      const body = await c.req.raw.clone().json();
      if (!c.req.header("Idempotency-Key")) c.req.raw.headers.set("Idempotency-Key", "7163_attachment_test_0123456789");
      let hash = "a".repeat(64);
      try {
        hash = createHash("sha256").update(canonicalParticipantRequest("submit-evidence", body)).digest("hex");
      } catch {
        /* invalid input still exercises authorization first */
      }
      c.req.raw.headers.set("X-Support-Request-Hash", hash);
    }
    await next();
  });
  app.route("/support-requests", createAccountSupportRequestRoutes(runtime));
  return app;
}

async function attachmentRouteFixture(exists = true, buyerAccountId = "acc_buyer", caseAuditTenant = "tnt_identity") {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const body = new Uint8Array([0xff, 0xd8, 0xff]);
  const reference = `support-attachment:v1:sea_photo:${createHash("sha256").update(body).digest("hex")}:jpg`;
  if (exists)
    await eventStore.appendToStream({
      streamId: "support.support-request-sup_case",
      expectedVersion: "any",
      context: {
        tenantId: caseAuditTenant,
        audit: { performedByUserId: "usr_operator", forAccountId: "acc_buyer" },
      } as never,
      events: [
        ...decideSupportRequest(initialSupportRequestState, {
          type: "OpenSupportRequest",
          supportRequestId: "sup_case",
          orderId: "ord_case",
          buyerAccountId,
          sellerAccountId: "acc_seller",
          openedByAccountId: "acc_buyer",
          openedByRole: "buyer",
          flowType: "product-damaged",
          openedAt: "2026-10-12T00:00:00.000Z",
          orderTotalAmount: "10.00",
          orderReturnContext: [],
        } as never).map((event) => ({ eventType: event.type, payload: event.data })),
        {
          eventType: "support.support-request.evidence-submitted",
          payload: {
            supportRequestId: "sup_case",
            evidence: { attachments: [reference], submittedAt: "2026-10-12T00:00:00.000Z" },
            updatedChecklist: [],
          },
        },
      ],
    });
  const storedKeys = new Set<string>();
  const storage = {
    putPrivate: vi.fn(async (input: { key: string }) => {
      storedKeys.add(input.key);
      return { status: "completed" as const, key: input.key };
    }),
    readPrivate: vi.fn(async () => ({
      status: "found" as const,
      body,
      byteSize: body.length,
      providerContentType: "image/jpeg",
    })),
    verifyPrivate: vi.fn(async (key: string) => ({
      status: storedKeys.has(key) ? ("match" as const) : ("absent" as const),
    })),
  };
  const runtime = createSupportRequestRuntime({
    eventStore,
    db: { query: vi.fn(async () => ({ rows: [supportRequestDetail()] })) } as never,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    attachmentStorage: storage,
    attachmentCanonicalizer: createSupportEvidenceCanonicalizationQueue({
      canonicalize: canonicalizeSupportEvidenceImage,
    }),
  });
  return { runtime, eventStore, allEvents, storage, reference };
}

function supportRequestDetail(): SupportOperationsRequestDetailRow {
  return {
    operatorPolicy: {
      deadlineAt: null,
      recommendedAction: "response",
      responsibilityReasons: [],
      refundCap: null,
      refundPrefill: null,
    },
    support_request_id: "sup_1",
    display_reference: "SUP-00000001",
    order_id: "ord_1",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    status: "ready-for-support",
    priority: "urgent",
    opened_by_account_id: "acc_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: "2026-06-02T00:00:00.000Z",
    seller_condition_attestation_due_at: null,
    order_return_context: [],
    return_investigation: null,
    checklist: [],
    evidence: [],
    responses: [],
    offers: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
    return_refund_gate_status: null,
    return_delivered_at: null,
    return_refund_release_due_at: null,
    return_condition_disputed_at: null,
    remedy: null,
    remedy_approval: null,
    case_presentation: "decision-pending",
    closure_eligible: false,
    closure_blocking_reasons: [],
    next_remedy_action: null,
    remedy_repair_guidance: [],
    contested: false,
  };
}

function supportOperationsListRow(
  supportRequestId: string,
  deadlineAt: string | null,
): SupportOperationsRequestListRow {
  const { evidence: _evidence, responses: _responses, offers: _offers, ...listRow } = supportRequestDetail();
  return { ...listRow, support_request_id: supportRequestId, operatorPolicy: { deadlineAt } };
}

function createServices(overrides: Partial<SupportRequestServices> = {}): SupportRequestServices {
  return {
    stageParticipantIntakeAttachments: vi.fn(),
    executeParticipantAttempt: vi.fn(),
    getParticipantAttempt: vi.fn(),
    commandHandler: vi.fn(),
    listFlowDefinitions: vi.fn(async () => []),
    resolveSupportFlowDefinition: vi.fn(async (flowType) => getSupportFlowDefinition(flowType)),
    getSupportOrderContext: vi.fn(),
    openSupportRequest: vi.fn(),
    openAutomatedSellerCannotFulfillRequest: vi.fn(),
    uploadAttachments: vi.fn(),
    getAttachment: vi.fn(),
    getEvidenceAccessAudit: vi.fn(),
    requestAttachmentCleanup: vi.fn(),
    attachmentCleanup: { kind: "not-mounted" },
    submitEvidence: vi.fn(),
    recordResponse: vi.fn(),
    acceptOffer: vi.fn(),
    declineOffer: vi.fn(),
    escalateSupportRequest: vi.fn(),
    resolveSupportRequest: vi.fn(),
    previewRemedyProposal: vi.fn(),
    proposeRemedy: vi.fn(),
    approveRemedy: vi.fn(),
    retryRemedyEffect: vi.fn(),
    requestRemedyCorrection: vi.fn(),
    recordRemedyEffect: vi.fn(),
    overrideRemedyEffect: vi.fn(),
    closeSupportRequest: vi.fn(),
    cancelSupportRequest: vi.fn(),
    escalateOverdueSupportRequests: vi.fn(),
    recordReturnDelivery: vi.fn(),
    disputeReturnCondition: vi.fn(),
    releaseReturnRefund: vi.fn(),
    listSupportRequestsAwaitingReturnDelivery: vi.fn(),
    sweepSupportRequestDeadlines: vi.fn(),
    listSupportOperationsQueue: vi.fn(),
    listBuyerSupportRequests: vi.fn(),
    listSellerSupportRequests: vi.fn(),
    getAccountSupportRequest: vi.fn(),
    getSupportOperationsRequest: vi.fn(async () => supportRequestDetail()),
    projectors: [],
    ...overrides,
  };
}

describe("support request routes", () => {
  it.each([
    [
      "support",
      "acc_operator",
      null,
      getSupportFlowDefinition("product-not-received").allowedResponses,
      getSupportFlowDefinition("product-not-received").allowedResolutions,
    ],
    ["seller", "acc_seller", null, getSupportFlowDefinition("product-not-received").allowedResponses, []],
    ["escalated seller", "acc_seller", "2026-06-01T01:00:00.000Z", [], []],
    ["buyer", "acc_buyer", null, [], []],
  ] as const)(
    "projects detail flow action arrays for %s from server role and state",
    async (_label, accountId, escalatedAt, allowedResponses, allowedResolutions) => {
      const detail = { ...supportRequestDetail(), escalated_at: escalatedAt };
      const participantDetail = (() => {
        const { operatorPolicy: _operatorPolicy, ...plainDetail } = detail;
        return plainDetail;
      })();
      const services = createServices({
        getSupportOperationsRequest: vi.fn(async () => detail as never),
        getAccountSupportRequest: vi.fn(async () => participantDetail as never),
      });
      const permissions = accountId === "acc_operator" ? ["support.manage"] : ["support.view"];
      const response = await buildApp(services, permissions, accountId).request(
        accountId === "acc_operator" ? "/support-requests/ops/sup_1" : "/support-requests/sup_1",
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ flow: { allowedResponses, allowedResolutions, flowType: "product-not-received" } });
      if (accountId !== "acc_operator") expect(body).not.toHaveProperty("operatorPolicy");
    },
  );

  it("proposes and records remedy execution through purpose-authorized command endpoints", async () => {
    const proposeRemedy = vi.fn(async () => ({
      supportRequestId: "sup_1",
      remedyId: "rmd_1",
      version: 8,
      status: "reservation-pending",
    }));
    const recordRemedyEffect = vi.fn(async () => ({ supportRequestId: "sup_1", remedyId: "rmd_1", version: 9 }));
    const services = createServices({ proposeRemedy, recordRemedyEffect });
    const app = buildApp(services);

    const authorization = await app.request("/support-requests/ops/sup_1/remedy-proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remedy: { kind: "full-refund", amount: "10.00", currencyCode: "usd" },
        allocation: {
          sellerFundedAmount: "0.00",
          platformFundedAmount: "10.00",
          currencyCode: "usd",
          fundingKind: "platform-funded",
        },
        returnDirective: "no-return",
        refundTrigger: "immediate",
        reasonCode: "insufficient-evidence",
        rationale: "Evidence is inconclusive.",
        evidenceReferences: ["evidence-1"],
        idempotencyKey: "proposal-1",
      }),
    });
    expect(authorization.status).toBe(200);
    await expect(authorization.json()).resolves.toEqual({
      id: "sup_1",
      remedyId: "rmd_1",
      version: 8,
      status: "reservation-pending",
    });

    const effect = await app.request("/support-requests/ops/sup_1/remedies/rmd_1/effects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        effect: "operator-release",
        idempotencyKey: "operator-release-1",
        occurredAt: "2026-07-04T00:00:00.000Z",
        reasonCode: "operator-reviewed-return-evidence",
      }),
    });
    expect(effect.status).toBe(200);
    expect(recordRemedyEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        supportRequestId: "sup_1",
        remedyId: "rmd_1",
        effect: "operator-release",
        outcome: "satisfied",
        sourceFactType: "support.support-request.operator-release-recorded",
        reasonCode: "operator-reviewed-return-evidence",
      }),
      expect.anything(),
    );

    const fabricatedFinancialFact = await app.request("/support-requests/ops/sup_1/remedies/rmd_1/effects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        effect: "settlement-reconciliation",
        idempotencyKey: "pretend-settled",
        reasonCode: "operator-says-settled",
      }),
    });
    expect(fabricatedFinancialFact.status).toBe(400);
    expect(recordRemedyEffect).toHaveBeenCalledTimes(1);

    const invalidRemedyId = await app.request("/support-requests/ops/sup_1/remedies/not-a-remedy/effects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        effect: "operator-release",
        idempotencyKey: "operator-release-invalid-remedy",
        reasonCode: "operator-reviewed-return-evidence",
      }),
    });
    expect(invalidRemedyId.status).toBe(400);
    expect(recordRemedyEffect).toHaveBeenCalledTimes(1);
  });

  it("requires the purpose-specific waiver permission for remedy overrides", async () => {
    const overrideRemedyEffect = vi.fn();
    const response = await buildApp(createServices({ overrideRemedyEffect }), ["support.view"]).request(
      "/support-requests/ops/sup_1/remedies/rmd_1/effects/facility-intake/override",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasonCode: "facility-confirmed-offline", idempotencyKey: "override-1" }),
      },
    );
    expect(response.status).toBe(403);
    expect(overrideRemedyEffect).not.toHaveBeenCalled();
  });

  it("does not let support.manage substitute for platform-remedy proposal authority", async () => {
    const proposeRemedy = vi.fn();
    const response = await buildApp(createServices({ proposeRemedy }), ["support.manage"]).request(
      "/support-requests/ops/sup_1/remedy-proposals",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(403);
    expect(proposeRemedy).not.toHaveBeenCalled();
  });

  it("returns account-scoped support order context for marketplace support lookup", async () => {
    const getSupportOrderContext = vi.fn(async () => ({
      orderId: "ord_1",
      openedByRole: "buyer" as const,
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
      lines: [],
    }));
    const services = createServices({ getSupportOrderContext });

    const response = await buildApp(services, ["support.view"]).request("/support-requests/orders/ord_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      orderId: "ord_1",
      openedByRole: "buyer",
      status: "ready-for-fulfillment",
      totalAmount: "24.00",
      lines: [],
    });
    expect(getSupportOrderContext).toHaveBeenCalledWith({
      orderId: "ord_1",
      accountId: "acc_operator",
    });
  });

  it.each([
    [
      "openSupportRequest",
      "/support-requests",
      { orderId: "ord_1", flowType: "product-not-received", affectedLineIds: ["line_1"] },
      { id: "sup_open", version: 1, status: "opened" },
    ],
    [
      "submitEvidence",
      "/support-requests/sup_1/evidence",
      { submittedByRole: "buyer", evidenceType: "photo", summary: "Package photo", attachments: ["att_1"] },
      { id: "sup_1", version: 2, status: "evidence-submitted" },
    ],
    [
      "recordResponse",
      "/support-requests/sup_1/responses",
      {
        submittedByRole: "seller",
        responseType: "challenge-with-evidence",
        summary: "Carrier scan attached",
        offerResolutionType: null,
        refundAmount: null,
      },
      { id: "sup_1", version: 3, status: "response-recorded" },
    ],
    [
      "acceptOffer",
      "/support-requests/sup_1/offers/sof_1/accept",
      {},
      { id: "sup_1", version: 8, status: "offer-accepted" },
    ],
    [
      "declineOffer",
      "/support-requests/sup_1/offers/sof_1/decline",
      { summary: "I still need support to review this." },
      { id: "sup_1", version: 9, status: "offer-declined" },
    ],
    [
      "escalateSupportRequest",
      "/support-requests/sup_1/escalate",
      { reason: "Needs support review" },
      { id: "sup_1", version: 4, status: "escalated" },
    ],
    [
      "resolveSupportRequest",
      "/support-requests/sup_1/resolve",
      {
        resolutionType: "replacement",
        summary: "Replacement approved",
        responsibility: "seller",
        evidenceBasis: { type: "operator-finding", reference: "support-test.operator-adjudication.v1" },
        responsibilityReasonCode: "wrong-product-received.seller-sent-wrong-product",
      },
      { id: "sup_1", version: 5, status: "resolved" },
    ],
    ["closeSupportRequest", "/support-requests/sup_1/close", {}, { id: "sup_1", version: 6, status: "closed" }],
    [
      "cancelSupportRequest",
      "/support-requests/sup_1/cancel",
      { reason: "Buyer withdrew request" },
      { id: "sup_1", version: 7, status: "cancelled" },
    ],
  ] as const)("returns a command-owned snapshot for %s", async (methodName, path, body, expected) => {
    const participant = methodName !== "resolveSupportRequest";
    const executeParticipantAttempt = vi.fn<SupportRequestServices["executeParticipantAttempt"]>(async () => {
      if (expected.status === "resolved") throw new Error("Adjudication is not a participant command");
      return { ...expected, evidenceId: null, responseId: null, offerId: null };
    });
    const resolveSupportRequest = vi.fn<SupportRequestServices["resolveSupportRequest"]>(async () => ({
      supportRequestId: expected.id,
      version: expected.version,
    }));
    const command = participant ? executeParticipantAttempt : resolveSupportRequest;
    const services = createServices({ executeParticipantAttempt, resolveSupportRequest });

    const response = await buildApp(services).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "7163_snapshot_test_0123456789",
        "X-Support-Request-Hash": "a".repeat(64),
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(methodName === "openSupportRequest" ? 201 : 200);
    await expect(response.json()).resolves.toEqual(
      participant ? { ...expected, evidenceId: null, responseId: null, offerId: null } : expected,
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns command-owned support operations escalation counts, including whether the sweep was capped", async () => {
    const escalateOverdueSupportRequests = vi.fn(async () => ({
      escalated: 3,
      skipped: 2,
      capped: true,
      total: 120,
    }));
    const services = createServices({ escalateOverdueSupportRequests });

    const response = await buildApp(services).request("/support-requests/ops/escalate-overdue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 10 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ escalated: 3, skipped: 2, capped: true, total: 120 });
    expect(escalateOverdueSupportRequests).toHaveBeenCalledWith({ limit: 10 }, expect.any(Object));
  });

  it("forwards status, priority, and search query params to the operations queue read model", async () => {
    const items: SupportOperationsRequestListRow[] = [
      supportOperationsListRow("sup_1", "2026-06-01T01:00:00.000Z"),
      supportOperationsListRow("sup_2", "2026-06-01T02:00:00.000Z"),
    ];
    const listSupportOperationsQueue = vi.fn(async () => ({ items, total: 5 }));
    const services = createServices({ listSupportOperationsQueue });

    const response = await buildApp(services).request(
      "/support-requests/ops?limit=25&offset=50&status=ready-for-support&priority=urgent&search=ord_1",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ items, total: 5, count: 2 });
    expect(
      body.items.map((item: SupportOperationsRequestListRow) => [item.support_request_id, item.operatorPolicy]),
    ).toEqual([
      ["sup_1", { deadlineAt: "2026-06-01T01:00:00.000Z" }],
      ["sup_2", { deadlineAt: "2026-06-01T02:00:00.000Z" }],
    ]);
    expect(listSupportOperationsQueue).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      status: "ready-for-support",
      priority: "urgent",
      search: "ord_1",
    });
  });

  it("omits status, priority, and search from the operations queue read model call when absent", async () => {
    const listSupportOperationsQueue = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSupportOperationsQueue });

    await buildApp(services).request("/support-requests/ops");

    expect(listSupportOperationsQueue).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      status: undefined,
      priority: undefined,
      search: undefined,
    });
  });

  it("AC5 forwards unresolved and its page window unchanged", async () => {
    const listSupportOperationsQueue = vi.fn(async () => ({ items: [], total: 5 }));
    const response = await buildApp(createServices({ listSupportOperationsQueue })).request(
      "/support-requests/ops?status=unresolved&limit=2&offset=2",
    );
    expect(response.status).toBe(200);
    expect(listSupportOperationsQueue).toHaveBeenCalledWith({
      status: "unresolved",
      limit: 2,
      offset: 2,
      priority: undefined,
      search: undefined,
    });
    await expect(response.json()).resolves.toEqual({ items: [], total: 5, count: 0 });
  });

  it.each([
    [
      "submitEvidence",
      "/support-requests/ops/sup_1/evidence",
      { evidenceType: "support-note", summary: "Operator note" },
      {
        id: "sup_1",
        version: 8,
        status: "evidence-submitted",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          submittedByRole: "support",
          evidenceType: "support-note",
          summary: "Operator note",
          occurredAt: null,
          attachments: [],
          scope: "operations",
        },
      },
    ],
    [
      "recordResponse",
      "/support-requests/ops/sup_1/responses",
      { responseType: "request-support-review", summary: "Reviewed by support" },
      {
        id: "sup_1",
        version: 9,
        status: "response-recorded",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          submittedByRole: "support",
          responseType: "request-support-review",
          summary: "Reviewed by support",
          offerResolutionType: null,
          refundAmount: null,
          scope: "operations",
        },
      },
    ],
    [
      "escalateSupportRequest",
      "/support-requests/ops/sup_1/escalate",
      { reason: "Needs support owner" },
      {
        id: "sup_1",
        version: 10,
        status: "escalated",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          reason: "Needs support owner",
          scope: "operations",
        },
      },
    ],
    [
      "resolveSupportRequest",
      "/support-requests/ops/sup_1/resolve",
      {
        resolutionType: "support-reviewed",
        summary: "Reviewed",
        refundAmount: null,
        responsibility: "undetermined",
        evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
        responsibilityReasonCode: "product-damaged.conflicting-evidence",
      },
      {
        id: "sup_1",
        version: 11,
        status: "resolved",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          resolutionType: "support-reviewed",
          summary: "Reviewed",
          refundAmount: null,
          responsibility: "undetermined",
          evidenceBasis: { type: "insufficient-evidence", reference: "support-test.conflicting-evidence.v1" },
          responsibilityReasonCode: "product-damaged.conflicting-evidence",
          scope: "operations",
        },
      },
    ],
    [
      "closeSupportRequest",
      "/support-requests/ops/sup_1/close",
      {},
      {
        id: "sup_1",
        version: 12,
        status: "closed",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          scope: "operations",
        },
      },
    ],
    [
      "cancelSupportRequest",
      "/support-requests/ops/sup_1/cancel",
      { reason: "Duplicate case" },
      {
        id: "sup_1",
        version: 13,
        status: "cancelled",
        expected: {
          supportRequestId: "sup_1",
          accountId: "acc_operator",
          reason: "Duplicate case",
          scope: "operations",
        },
      },
    ],
  ] as const)("returns an ops-scoped command snapshot for %s", async (methodName, path, body, expectation) => {
    const command = vi.fn(async () => ({
      supportRequestId: expectation.id,
      version: expectation.version,
    }));
    const services = createServices({ [methodName]: command } as Partial<SupportRequestServices>);

    const response = await buildApp(services).request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: expectation.id,
      version: expectation.version,
      status: expectation.status,
    });
    expect(command).toHaveBeenCalledWith(expectation.expected, expect.any(Object));
  });

  it("lets support operators read request details outside participant account scope", async () => {
    const services = createServices();
    const response = await buildApp(services).request(
      "/support-requests/ops/sup_1?now=2000-01-01T00:00:00Z&deadlineAt=forged&recommendedAction=resolve&refundCap=999.00",
      { headers: { "X-Now": "2000-01-01T00:00:00Z" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      support_request_id: "sup_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
      operatorPolicy: supportRequestDetail().operatorPolicy,
    });
    expect(services.getSupportOperationsRequest).toHaveBeenCalledWith("sup_1");
  });

  it("keeps operations detail reads behind support manage permission", async () => {
    const response = await buildApp(createServices(), ["support.view"]).request("/support-requests/ops/sup_1");

    expect(response.status).toBe(403);
  });

  it("uploads private evidence through the authenticated case-scoped boundary", async () => {
    const uploadAttachments = vi.fn(async () => [
      {
        attachmentId: "sea_photo",
        reference:
          "support-attachment:v1:sea_photo:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:jpg",
        contentType: "image/jpeg" as const,
        byteSize: 3,
      },
    ]);
    const response = await buildApp(createServices({ uploadAttachments })).request(
      "/support-requests/sup_1/attachments",
      { method: "POST", body: new URLSearchParams({ attachments: "non-file entries are ignored" }) },
    );

    expect(response.status, await response.clone().text()).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      attachments: [{ attachmentId: "sea_photo", contentType: "image/jpeg", byteSize: 3 }],
    });
    expect(uploadAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        supportRequestId: "sup_1",
        actor: expect.objectContaining({
          accountId: "acc_operator",
          permissions: expect.arrayContaining(["support.manage"]),
        }),
        uploads: expect.any(Function),
      }),
    );
  });

  it("returns a private no-sniff image response only when case access resolves", async () => {
    const getAttachment = vi.fn(async () => ({
      body: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: "image/jpeg" as const,
    }));
    const response = await buildApp(createServices({ getAttachment }), ["support.view"]).request(
      "/support-requests/sup_1/attachments/sea_photo",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  });

  it("does not reveal attachments when the case-scoped read returns no access", async () => {
    const getAttachment = vi.fn(async () => null);
    const response = await buildApp(createServices({ getAttachment }), ["support.view"]).request(
      "/support-requests/sup_1/attachments/sea_photo",
    );

    expect(response.status).toBe(404);
  });
});

const attestationDueAt = "2026-06-03T00:00:00.000Z";
const responseDueAt = "2026-06-02T00:00:00.000Z";
const reviewDueAt = "2026-06-04T00:00:00.000Z";

function participantRow(overrides: Record<string, unknown> = {}) {
  return {
    ...supportRequestDetail(),
    status: "waiting-on-seller",
    seller_condition_attestation_due_at: attestationDueAt,
    seller_response_due_at: responseDueAt,
    support_review_due_at: reviewDueAt,
    ...overrides,
  };
}

function checklistItem(
  key: string,
  ownerRole: SupportRequesterRole,
  required = true,
  satisfiedAt: string | null = null,
) {
  return { key, label: `Provide ${key}`, ownerRole, evidenceTypes: ["photo"], required, satisfiedAt };
}

function pendingOffer(pendingWithRole: SupportRequesterRole) {
  return {
    offerId: "sof_1",
    responseId: "srp_1",
    offeredByAccountId: "acc_seller",
    offeredByRole: "seller",
    pendingWithRole,
    responseType: "offer-partial-refund",
    resolutionType: "partial-refund",
    refundAmount: "12.00",
    summary: "Keep the item and receive a partial refund.",
    offeredAt: "2026-06-01T01:00:00.000Z",
    status: "pending",
    decidedByAccountId: null,
    decidedByRole: null,
    decidedAt: null,
    decisionSummary: null,
  };
}

function policy(
  nextActor: SupportParticipantPolicy["nextActor"],
  deadlineAt: string | null,
  ...actions: SupportParticipantAction[]
): SupportParticipantPolicy {
  return { nextActor, deadlineAt, actions };
}

const respond = { kind: "record-response" } as const;
const review = { kind: "escalate" } as const;
const cancel = { kind: "cancel" } as const;
const accept = { kind: "accept-offer" } as const;
const decline = { kind: "decline-offer" } as const;
const prompt = (checklistItemKey: string) => ({ kind: "submit-evidence", checklistItemKey }) as const;

async function readParticipantDetail(
  row: ReturnType<typeof participantRow>,
  accountId: string,
  {
    path = "/support-requests/sup_1",
    headers,
    definition,
  }: Readonly<{ path?: string; headers?: Record<string, string>; definition?: SupportFlowDefinition }> = {},
) {
  const services = createServices({
    // Mirrors the account-scoped read: `buyer_account_id = $2 OR seller_account_id = $2`.
    getAccountSupportRequest: vi.fn(async (_supportRequestId: string, scopedAccountId: string) =>
      row.buyer_account_id === scopedAccountId || row.seller_account_id === scopedAccountId ? (row as never) : null,
    ),
    ...(definition ? { resolveSupportFlowDefinition: vi.fn(async () => definition) } : {}),
  });
  const response = await buildApp(services, ["support.view"], accountId).request(path, headers ? { headers } : {});
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, services };
}

describe("support-request-detail-participant-policy", () => {
  it("waiting-on-seller: the seller acts next with response and review actions while the buyer opener waits with none", async () => {
    const row = participantRow();

    const seller = await readParticipantDetail(row, "acc_seller");
    expect(seller.status).toBe(200);
    expect(seller.body.participantPolicy).toEqual(policy("seller", attestationDueAt, respond, review));

    const buyer = await readParticipantDetail(row, "acc_buyer");
    expect(buyer.status).toBe(200);
    expect(buyer.body.participantPolicy).toEqual(policy("seller", attestationDueAt));
  });

  it("unsatisfied checklist: the first required non-support item names the next actor and only its owner gets prompts", async () => {
    const row = participantRow({
      checklist: [
        checklistItem("support-note", "support"),
        checklistItem("buyer-optional", "buyer", false),
        checklistItem("buyer-attestation", "buyer", true, "2026-06-01T00:30:00.000Z"),
        checklistItem("buyer-photos", "buyer"),
        checklistItem("seller-attestation", "seller"),
        checklistItem("buyer-notes", "buyer"),
      ],
    });

    expect((await readParticipantDetail(row, "acc_buyer")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt, prompt("buyer-photos"), prompt("buyer-notes"), cancel),
    );
    expect((await readParticipantDetail(row, "acc_seller")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt),
    );
  });

  it("pending offer: only its holder may accept or decline, and the offer outranks unsatisfied checklist prompts", async () => {
    const row = participantRow({
      pending_offer: pendingOffer("buyer"),
      checklist: [checklistItem("seller-attestation", "seller"), checklistItem("buyer-photos", "buyer")],
    });

    expect((await readParticipantDetail(row, "acc_buyer")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt, accept, decline, cancel),
    );
    expect((await readParticipantDetail(row, "acc_seller")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt),
    );
  });

  it.each(["resolved", "closed", "cancelled"])(
    "%s: a terminal request names no next actor and gives neither party an action",
    async (status) => {
      const row = participantRow({
        status,
        pending_offer: pendingOffer("buyer"),
        checklist: [checklistItem("buyer-photos", "buyer")],
      });

      for (const accountId of ["acc_buyer", "acc_seller"]) {
        expect((await readParticipantDetail(row, accountId)).body.participantPolicy).toEqual(
          policy(null, responseDueAt),
        );
      }
    },
  );

  it("an unrelated account reads 404 with no policy while each party of the row gets its own policy", async () => {
    const row = participantRow({ status: "waiting-on-buyer" });

    const unrelated = await readParticipantDetail(row, "acc_other");
    expect(unrelated.status).toBe(404);
    expect(unrelated.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(unrelated.services.getAccountSupportRequest).toHaveBeenCalledWith("sup_1", "acc_other");

    expect((await readParticipantDetail(row, "acc_buyer")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt, review, cancel),
    );
    expect((await readParticipantDetail(row, "acc_seller")).body.participantPolicy).toEqual(
      policy("buyer", responseDueAt),
    );
  });

  it("request-supplied role, account and opener inputs cannot alter the authenticated participant's policy", async () => {
    const forged = await readParticipantDetail(participantRow(), "acc_buyer", {
      path: "/support-requests/sup_1?role=seller&viewerRole=seller&accountId=acc_seller&submittedByRole=seller&canCancel=true",
      headers: { "x-support-role": "seller", "x-account-id": "acc_seller" },
    });

    expect(forged.status).toBe(200);
    expect(forged.body.participantPolicy).toEqual(policy("seller", attestationDueAt));
    expect(forged.services.getAccountSupportRequest).toHaveBeenCalledWith("sup_1", "acc_buyer");
  });

  it("refuses an account without support.view before reading the row", async () => {
    const services = createServices({ getAccountSupportRequest: vi.fn() });
    const response = await buildApp(services, [], "acc_buyer").request("/support-requests/sup_1");

    expect(response.status).toBe(403);
    expect(services.getAccountSupportRequest).not.toHaveBeenCalled();
  });

  it("adds participantPolicy as the only new key from one row read and leaves the operations detail without it", async () => {
    expectTypeOf<SupportRequestDetailResponse>().toEqualTypeOf<
      SupportRequestDetailRow & Readonly<{ flow: SupportFlowDetail }>
    >();
    expectTypeOf<SupportRequestParticipantDetailResponse>().toEqualTypeOf<
      SupportRequestDetailResponse & Readonly<{ participantPolicy: SupportParticipantPolicy }>
    >();
    expectTypeOf<SupportParticipantPolicy>().toEqualTypeOf<
      Readonly<{
        nextActor: SupportRequesterRole | null;
        deadlineAt: string | null;
        actions: readonly SupportParticipantAction[];
      }>
    >();

    const row = participantRow();
    const { body, services } = await readParticipantDetail(row, "acc_seller");
    const { participantPolicy, ...existing } = body;
    expect(existing).toEqual({
      ...row,
      flow: projectSupportFlow(getSupportFlowDefinition("product-not-received"), "seller", row),
    });
    expect(participantPolicy).toEqual(policy("seller", attestationDueAt, respond, review));
    expect(
      Object.entries(services)
        .filter(([, service]) => vi.isMockFunction(service) && service.mock.calls.length > 0)
        .map(([name]) => name)
        .sort(),
    ).toEqual(["getAccountSupportRequest", "resolveSupportFlowDefinition"]);
    expect(services.getAccountSupportRequest).toHaveBeenCalledTimes(1);
    expect(services.resolveSupportFlowDefinition).toHaveBeenCalledTimes(1);

    const operations = await buildApp(
      createServices({ getSupportOperationsRequest: vi.fn(async () => row as never) }),
    ).request("/support-requests/ops/sup_1");
    expect(operations.status).toBe(200);
    expect(Object.keys((await operations.json()) as Record<string, unknown>)).not.toContain("participantPolicy");
  });
});

const sellerOpened = { opened_by_account_id: "acc_seller", opened_by_role: "seller" };
const escalated = { escalated_at: "2026-06-01T02:00:00.000Z" };
const flowWithoutReview: SupportFlowDefinition = {
  ...getSupportFlowDefinition("product-not-received"),
  allowedResponses: getSupportFlowDefinition("product-not-received").allowedResponses.filter(
    (response) => response !== "request-support-review",
  ),
};

describe("support-request-detail-participant-policy-matrix", () => {
  it.each([
    // status mapping with no pending offer and no checklist item open
    ["open: the buyer waits on support", {}, "open", "acc_buyer", policy("support", reviewDueAt)],
    ["open: the seller waits on support", {}, "open", "acc_seller", policy("support", reviewDueAt)],
    [
      "waiting-on-buyer: the buyer opener may request review or cancel",
      {},
      "waiting-on-buyer",
      "acc_buyer",
      policy("buyer", responseDueAt, review, cancel),
    ],
    ["waiting-on-buyer: the seller waits", {}, "waiting-on-buyer", "acc_seller", policy("buyer", responseDueAt)],
    [
      "waiting-on-seller: the seller responds or requests review",
      {},
      "waiting-on-seller",
      "acc_seller",
      policy("seller", attestationDueAt, respond, review),
    ],
    [
      "waiting-on-seller: the buyer opener waits and cannot cancel",
      {},
      "waiting-on-seller",
      "acc_buyer",
      policy("seller", attestationDueAt),
    ],
    [
      "ready-for-support: the buyer waits on support",
      {},
      "ready-for-support",
      "acc_buyer",
      policy("support", reviewDueAt),
    ],
    [
      "ready-for-support: the seller waits on support",
      {},
      "ready-for-support",
      "acc_seller",
      policy("support", reviewDueAt),
    ],
    ["resolved: the buyer has no next actor", {}, "resolved", "acc_buyer", policy(null, responseDueAt)],
    ["resolved: the seller has no next actor", {}, "resolved", "acc_seller", policy(null, responseDueAt)],
    ["closed: the buyer has no next actor", {}, "closed", "acc_buyer", policy(null, responseDueAt)],
    ["closed: the seller has no next actor", {}, "closed", "acc_seller", policy(null, responseDueAt)],
    ["cancelled: the buyer has no next actor", {}, "cancelled", "acc_buyer", policy(null, responseDueAt)],
    ["cancelled: the seller has no next actor", {}, "cancelled", "acc_seller", policy(null, responseDueAt)],
    // opener gate follows the authenticated account
    [
      "the seller opener acting next may cancel",
      sellerOpened,
      "waiting-on-seller",
      "acc_seller",
      policy("seller", attestationDueAt, respond, review, cancel),
    ],
    [
      "the buyer acting next without opening may not cancel",
      sellerOpened,
      "waiting-on-buyer",
      "acc_buyer",
      policy("buyer", responseDueAt, review),
    ],
    // deadline fallbacks and null controls
    [
      "the seller deadline falls back to the response deadline",
      { seller_condition_attestation_due_at: null },
      "waiting-on-seller",
      "acc_seller",
      policy("seller", responseDueAt, respond, review),
    ],
    [
      "the seller deadline is null without attestation or response deadlines",
      { seller_condition_attestation_due_at: null, seller_response_due_at: null },
      "waiting-on-seller",
      "acc_seller",
      policy("seller", null, respond, review),
    ],
    [
      "the support deadline is only the review deadline",
      { support_review_due_at: null },
      "ready-for-support",
      "acc_buyer",
      policy("support", null),
    ],
    [
      "the buyer deadline falls back to the review deadline",
      { seller_response_due_at: null },
      "waiting-on-buyer",
      "acc_buyer",
      policy("buyer", reviewDueAt, review, cancel),
    ],
    [
      "the buyer deadline never uses the attestation deadline",
      { seller_response_due_at: null, support_review_due_at: null },
      "waiting-on-buyer",
      "acc_buyer",
      policy("buyer", null, review, cancel),
    ],
    [
      "a terminal deadline is null without response or review deadlines",
      { seller_response_due_at: null, support_review_due_at: null },
      "resolved",
      "acc_seller",
      policy(null, null),
    ],
    // pending offer outranks checklist and status
    [
      "an offer pending with the buyer outranks the seller's open item",
      { pending_offer: pendingOffer("buyer"), checklist: [checklistItem("seller-attestation", "seller")] },
      "waiting-on-seller",
      "acc_buyer",
      policy("buyer", responseDueAt, accept, decline, cancel),
    ],
    [
      "the seller waits on an offer pending with the buyer",
      { pending_offer: pendingOffer("buyer"), checklist: [checklistItem("seller-attestation", "seller")] },
      "waiting-on-seller",
      "acc_seller",
      policy("buyer", responseDueAt),
    ],
    [
      "an offer pending with the seller lets only the seller decide",
      { pending_offer: pendingOffer("seller") },
      "waiting-on-buyer",
      "acc_seller",
      policy("seller", attestationDueAt, accept, decline),
    ],
    [
      "the buyer opener waits on an offer pending with the seller",
      { pending_offer: pendingOffer("seller") },
      "waiting-on-buyer",
      "acc_buyer",
      policy("seller", attestationDueAt),
    ],
    [
      "an offer pending with support leaves the buyer waiting",
      { pending_offer: pendingOffer("support") },
      "waiting-on-buyer",
      "acc_buyer",
      policy("support", reviewDueAt),
    ],
    [
      "an offer pending with support leaves the seller waiting",
      { pending_offer: pendingOffer("support") },
      "waiting-on-seller",
      "acc_seller",
      policy("support", reviewDueAt),
    ],
    // checklist precedence
    [
      "a support-owned item never names the next actor",
      { checklist: [checklistItem("support-note", "support"), checklistItem("seller-attestation", "seller")] },
      "waiting-on-buyer",
      "acc_seller",
      policy("seller", attestationDueAt, prompt("seller-attestation")),
    ],
    [
      "the buyer waits on the seller's open item",
      { checklist: [checklistItem("support-note", "support"), checklistItem("seller-attestation", "seller")] },
      "waiting-on-buyer",
      "acc_buyer",
      policy("seller", attestationDueAt),
    ],
    [
      "optional and satisfied items leave the status mapping in charge",
      {
        checklist: [
          checklistItem("buyer-optional", "buyer", false),
          checklistItem("buyer-attestation", "buyer", true, "2026-06-01T00:30:00.000Z"),
        ],
      },
      "waiting-on-seller",
      "acc_seller",
      policy("seller", attestationDueAt, respond, review),
    ],
    [
      "the buyer gets no prompt for optional or satisfied items",
      {
        checklist: [
          checklistItem("buyer-optional", "buyer", false),
          checklistItem("buyer-attestation", "buyer", true, "2026-06-01T00:30:00.000Z"),
        ],
      },
      "waiting-on-seller",
      "acc_buyer",
      policy("seller", attestationDueAt),
    ],
    [
      "an owned open item outranks the ready-for-support status",
      { checklist: [checklistItem("buyer-photos", "buyer")] },
      "ready-for-support",
      "acc_buyer",
      policy("buyer", responseDueAt, prompt("buyer-photos"), cancel),
    ],
    [
      "the seller waits on the buyer's open item",
      { checklist: [checklistItem("buyer-photos", "buyer")] },
      "ready-for-support",
      "acc_seller",
      policy("buyer", responseDueAt),
    ],
    // the seller's review action follows the projected flow; the buyer's does not
    [
      "an escalated seller may respond but has no review action",
      escalated,
      "waiting-on-seller",
      "acc_seller",
      policy("seller", attestationDueAt, respond),
    ],
    [
      "the buyer's review action does not depend on escalation",
      escalated,
      "waiting-on-buyer",
      "acc_buyer",
      policy("buyer", responseDueAt, review, cancel),
    ],
  ] as const)("%s", async (_name, overrides, status, accountId, expected) => {
    const { status: httpStatus, body } = await readParticipantDetail(
      participantRow({ ...overrides, status }),
      accountId,
    );
    expect(httpStatus).toBe(200);
    expect(body.participantPolicy).toEqual(expected);
  });

  it("a flow without request-support-review gives the seller no review action and leaves the buyer's", async () => {
    const seller = await readParticipantDetail(participantRow(), "acc_seller", { definition: flowWithoutReview });
    expect(seller.body.participantPolicy).toEqual(policy("seller", attestationDueAt, respond));

    const buyer = await readParticipantDetail(participantRow({ status: "waiting-on-buyer" }), "acc_buyer", {
      definition: flowWithoutReview,
    });
    expect(buyer.body.participantPolicy).toEqual(policy("buyer", responseDueAt, review, cancel));
  });
});

describe("human Support evidence cleanup requests (AC-E5)", () => {
  const operationId = "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const operationStream = attachmentOperationStreamId({ supportRequestId: "sup_case", operationId });
  const cleanupPath = `/support-requests/ops/sup_case/attachment-operations/${operationId}/cleanup`;
  async function cleanupFixture(referenced = false) {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "support.support-request-sup_case",
      expectedVersion: "no_stream",
      context: evidenceActorContext(evidenceActor("owner", [], false, "acc_buyer")),
      events: decideSupportRequest(initialSupportRequestState, {
        type: "OpenSupportRequest",
        supportRequestId: "sup_case",
        orderId: "ord_case",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        openedByAccountId: "acc_buyer",
        openedByRole: "buyer",
        flowType: "product-damaged",
        openedAt: "2026-10-12T00:00:00.000Z",
        orderTotalAmount: "10.00",
        orderReturnContext: [],
      } as never).map((event) => ({ eventType: event.type, payload: event.data })),
    });
    const owner = { tenantId: "tnt_identity", accountId: "acc_buyer", supportRequestId: "sup_case", operationId };
    const manifest = createAttachmentManifest({
      owner,
      profile: "support-evidence-raster/v1",
      encoderFingerprint: {
        profile: "support-evidence-raster/v1",
        sharp: "t",
        libvips: "t",
        platform: "t",
        arch: "t",
        libc: "t",
      },
      images: [{ canonicalSha256: "c".repeat(64), contentType: "image/jpeg", byteSize: 3 }],
    });
    await eventStore.appendToStream({
      streamId: operationStream,
      expectedVersion: "no_stream",
      context: evidenceActorContext(evidenceActor("owner", [], false, "acc_buyer")),
      events: [
        { eventType: "support.attachment-operation.staged", payload: manifest },
        { eventType: "support.attachment-operation.stored", payload: { index: 0 } },
        ...(referenced
          ? [
              {
                eventType: "support.attachment-operation.reference-claimed",
                payload: {
                  evidenceId: "sev_case",
                  attachments: attachmentManifestReferences(manifest),
                  submittedAt: "2026-10-12T00:00:00.000Z",
                },
              },
              { eventType: "support.attachment-operation.referenced", payload: { evidenceId: "sev_case" } },
            ]
          : []),
      ],
    });
    const storage = {
      putPrivate: vi.fn(),
      readPrivate: vi.fn(),
      verifyPrivate: vi.fn(),
      deleteKeys: vi.fn(),
    };
    const binding = parseSupportEvidenceCleanupBinding(
      JSON.stringify({
        version: 1,
        environment: "test",
        deploymentInstance: '["support-deployment-instance/v1","test","release-a"]',
        bindingId: "cleanup-a",
        revision: 1,
        active: true,
      }),
      {
        environment: "test",
        deploymentInstance: '["support-deployment-instance/v1","test","release-a"]',
        implementationSha: "a".repeat(40),
      },
    );
    if (binding.kind !== "configured") throw new Error("test binding must be configured");
    const runtime = createSupportRequestRuntime({
      eventStore,
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      attachmentStorage: storage,
      // Even with the worker capability mounted in-process, the human route only records a requirement.
      attachmentCleanup: { kind: "available", binding, storage },
    });
    const operationEvents = () => allEvents.filter((event) => event.streamId === operationStream);
    const auditEvents = () => allEvents.filter((event) => event.streamId === "support.evidence-access-sup_case");
    return { runtime, storage, operationEvents, auditEvents };
  }
  const post = (fixture: Awaited<ReturnType<typeof cleanupFixture>>, actor: ResolvedActor | null, path = cleanupPath) =>
    attachmentApp(fixture.runtime, actor).request(path, { method: "POST" });
  const expectNoStorage = (fixture: Awaited<ReturnType<typeof cleanupFixture>>) => {
    for (const method of Object.values(fixture.storage)) expect(method).not.toHaveBeenCalled();
  };

  it("any-case with support.manage records CleanupRequired once and never deletes", async () => {
    const fixture = await cleanupFixture();
    const operator = evidenceActor("platform-admin", ["support.manage"], true, "acc_operator");
    const first = await post(fixture, operator);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ operationId, status: "cleanup-required" });
    expect((await post(fixture, operator)).status).toBe(202);
    const required = fixture.operationEvents().filter((event) => event.eventType.endsWith(".cleanup-required"));
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({
      payload: { reason: "human-request" },
      performedByUserId: "usr_operator",
      forAccountId: "acc_buyer",
    });
    expect(fixture.operationEvents()).toHaveLength(3);
    expect(fixture.auditEvents().map((event) => event.payload.action)).toEqual(["cleanup-request", "cleanup-request"]);
    expectNoStorage(fixture);
  });

  it.each([
    ["participant buyer", evidenceActor("owner", ["support.manage"], false, "acc_buyer"), 403],
    ["participant seller", evidenceActor("owner", ["support.manage"], false, "acc_seller"), 403],
    ["unrelated", evidenceActor("platform-admin", ["support.manage"], false, "acc_unrelated"), 404],
    [
      "revoked",
      { ...evidenceActor("platform-admin", ["support.manage"], true, "acc_unrelated"), capabilityAssignments: [] },
      404,
    ],
    ["any-case without support.manage", evidenceActor("viewer", ["support.view"], true, "acc_unrelated"), 403],
    ["anonymous", null, 401],
  ] as const)("%s denies with zero storage calls and no cleanup fact", async (_label, actor, status) => {
    const fixture = await cleanupFixture();
    expect((await post(fixture, actor)).status).toBe(status);
    expect(fixture.operationEvents()).toHaveLength(2);
    expect(fixture.auditEvents()).toHaveLength(1);
    expect(fixture.auditEvents()[0]!.payload).toMatchObject({ action: "cleanup-request", decision: "denied" });
    expectNoStorage(fixture);
  });

  it("refuses referenced, unknown and malformed operations without storage calls", async () => {
    const operator = evidenceActor("platform-admin", ["support.manage"], true, "acc_operator");
    const referenced = await cleanupFixture(true);
    const conflict = await post(referenced, operator);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("attachment_operation_referenced");
    expect(referenced.operationEvents()).toHaveLength(4);
    expectNoStorage(referenced);
    const fixture = await cleanupFixture();
    for (const path of [
      "/support-requests/ops/sup_case/attachment-operations/sao_01ARZ3NDEKTSV4RRFFQ69G5FAW/cleanup",
      "/support-requests/ops/sup_case/attachment-operations/sao_bad/cleanup",
      `/support-requests/ops/sup_other/attachment-operations/${operationId}/cleanup`,
    ])
      expect((await post(fixture, operator, path)).status).toBe(404);
    expect(fixture.operationEvents()).toHaveLength(2);
    expectNoStorage(fixture);
  });
});
