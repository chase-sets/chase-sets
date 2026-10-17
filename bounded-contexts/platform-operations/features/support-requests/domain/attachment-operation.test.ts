import { describe, expect, it } from "vitest";
import {
  attachmentOperationStreamId,
  attachmentManifestReferences,
  canonicalJson,
  createAttachmentManifest,
  deriveSupportEvidenceAttachmentId,
  decideAttachmentOperation,
  replayAttachmentOperation,
  SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS,
  type AttachmentOperationEvent,
} from "./attachment-operation";
import { SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS } from "../api/attachments";
import { parseSupportEvidenceAttachmentReference } from "./attachment-reference";

const owner = {
  tenantId: "tnt_identity",
  accountId: "acc_owner",
  supportRequestId: "sup_case",
  operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const fingerprint = {
  profile: "support-evidence-raster/v1",
  sharp: "test",
  libvips: "test",
  platform: "test",
  arch: "test",
  libc: "test",
};
const images = [
  { canonicalSha256: "a".repeat(64), contentType: "image/jpeg" as const, byteSize: 3 },
  { canonicalSha256: "b".repeat(64), contentType: "image/png" as const, byteSize: 4 },
];
const manifest = () =>
  createAttachmentManifest({ owner, profile: fingerprint.profile, encoderFingerprint: fingerprint, images });
const stage = (): AttachmentOperationEvent => ({ type: "support.attachment-operation.staged", data: manifest() });
const admitted = (index = 0, attempt = 1): AttachmentOperationEvent => ({
  type: "support.attachment-operation.put-admitted",
  data: { index, attempt },
});
const settled = (index = 0, attempt = 1): AttachmentOperationEvent => ({
  type: "support.attachment-operation.put-settled",
  data: { index, attempt, outcome: "completed" },
});
const stored = (index = 0): AttachmentOperationEvent => ({
  type: "support.attachment-operation.stored",
  data: { index },
});
const cleanup: AttachmentOperationEvent = {
  type: "support.attachment-operation.cleanup-required",
  data: { reason: "verification-conflict" },
};

describe("Support Attachment Operation", () => {
  it.each(["reference-claimed", "referenced"] as const)(
    "%s permits only exact staging and already-stored index no-ops, not upload or cleanup mutations",
    (status) => {
      const events: AttachmentOperationEvent[] = [
        stage(),
        stored(0),
        stored(1),
        {
          type: "support.attachment-operation.reference-claimed",
          data: {
            evidenceId: "sev_case",
            attachments: attachmentManifestReferences(manifest()),
            submittedAt: "2026-10-14T00:00:00.000Z",
          },
        },
      ];
      if (status === "referenced")
        events.push({ type: "support.attachment-operation.referenced", data: { evidenceId: "sev_case" } });
      const state = replayAttachmentOperation(events);
      expect(decideAttachmentOperation(state, { type: "StageSupportAttachmentOperation", data: manifest() })).toEqual(
        [],
      );
      for (const index of [0, 1])
        expect(decideAttachmentOperation(state, { type: "RecordSupportAttachmentStored", data: { index } })).toEqual(
          [],
        );
      expect(() =>
        decideAttachmentOperation(state, {
          type: "StageSupportAttachmentOperation",
          data: createAttachmentManifest({
            owner: { ...owner, accountId: "acc_other" },
            profile: fingerprint.profile,
            encoderFingerprint: fingerprint,
            images,
          }),
        }),
      ).toThrow("operation-conflict");
      expect(() =>
        decideAttachmentOperation(state, { type: "RecordSupportAttachmentStored", data: { index: 2 } }),
      ).toThrow("operation-terminal");
      expect(() =>
        decideAttachmentOperation(state, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
      ).toThrow("operation-terminal");
      expect(() =>
        decideAttachmentOperation(state, {
          type: "SettleSupportAttachmentPut",
          data: { index: 0, attempt: 1, outcome: "completed" },
        }),
      ).toThrow("operation-terminal");
      expect(() =>
        decideAttachmentOperation(state, {
          type: "RequireSupportAttachmentCleanup",
          data: { reason: "verification-absent" },
        }),
      ).toThrow("operation-terminal");
    },
  );
  it("claims the complete settled batch, rejects later puts and replays confirmation (mutant: partial-batch or put-after-claim bypass)", () => {
    const ready = replayAttachmentOperation([stage(), stored(0), stored(1)]);
    const data = {
      evidenceId: "sev_case",
      attachments: attachmentManifestReferences(manifest()),
      submittedAt: "2026-10-13T12:00:00.000Z",
    };
    expect(() =>
      decideAttachmentOperation(ready, {
        type: "ClaimSupportAttachmentReference",
        data: { ...data, attachments: data.attachments.slice(0, 1) },
      }),
    ).toThrow();
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation([stage(), admitted(), stored(0), stored(1)]), {
        type: "ClaimSupportAttachmentReference",
        data,
      }),
    ).toThrow();
    const claimedEvents = decideAttachmentOperation(ready, { type: "ClaimSupportAttachmentReference", data });
    const claimed = replayAttachmentOperation([stage(), stored(0), stored(1), ...claimedEvents]);
    expect(() =>
      decideAttachmentOperation(claimed, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
    ).toThrow("operation-terminal");
    expect(decideAttachmentOperation(claimed, { type: "ClaimSupportAttachmentReference", data })).toEqual([]);
    const released = decideAttachmentOperation(claimed, {
      type: "ReleaseSupportAttachmentReferenceClaim",
      data: { evidenceId: data.evidenceId },
    });
    expect(replayAttachmentOperation([stage(), stored(0), stored(1), ...claimedEvents, ...released]).status).toBe(
      "stored",
    );
    const confirmed = decideAttachmentOperation(claimed, {
      type: "ConfirmSupportAttachmentReferenced",
      data: { evidenceId: data.evidenceId },
    });
    expect(replayAttachmentOperation([stage(), stored(0), stored(1), ...claimedEvents, ...confirmed]).status).toBe(
      "referenced",
    );
  });
  it("rejects array-coerced canonical hashes rather than replaying poisoned manifest authority", () => {
    expect(() =>
      createAttachmentManifest({
        owner,
        profile: fingerprint.profile,
        encoderFingerprint: fingerprint,
        images: [{ ...images[0], canonicalSha256: [images[0].canonicalSha256] as never }],
      }),
    ).toThrow();
    expect(() =>
      deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: [images[0].canonicalSha256] as never }),
    ).toThrow();
  });
  it("malformed settlement cannot become a no-op because the attempt is missing", () => {
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation([stage()]), {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 1, outcome: undefined },
      } as never),
    ).toThrow();
  });
  it("derives full base32 SHA-256 tuple ids, with stable, disjoint case/operation/index/owner vectors", () => {
    const id = deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64) });
    expect(id).toMatch(/^sea_[a-z2-7]{52}$/);
    expect(id).toBe("sea_5l4i2aaiowepin26edebas6unzcgpphud455feyu24ov5jmocbma");
    expect(id).toBe(deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64) }));
    for (const change of [
      { supportRequestId: "sup_other" },
      { operationId: "sao_01ARZ3NDEKTSV4RRFFQ69G5FAW" },
      { index: 1 },
      { accountId: "acc_other" },
      { tenantId: "tnt_other" },
      { canonicalSha256: "b".repeat(64) },
    ])
      expect(
        deriveSupportEvidenceAttachmentId({ ...owner, index: 0, canonicalSha256: "a".repeat(64), ...change }),
      ).not.toBe(id);
    expect(
      parseSupportEvidenceAttachmentReference(`support-attachment:v1:${id}:${"a".repeat(64)}:jpg`)?.attachmentId,
    ).toBe(id);
    expect(attachmentOperationStreamId(owner)).toBe(`support.attachment-operation-sup_case-${owner.operationId}`);
  });

  it("canonical JSON sorts object keys, preserves manifest order, and pins all authority fields", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(manifest().manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest().items.map((i) => i.index)).toEqual([0, 1]);
    expect(manifest().items[0].attachmentId).not.toBe(manifest().items[1].attachmentId);
  });

  it("transitions absent -> staged -> partially-stored -> stored, suppressing exact retry and terminal duplicates", () => {
    const events = decideAttachmentOperation(replayAttachmentOperation([]), {
      type: "StageSupportAttachmentOperation",
      data: manifest(),
    });
    expect(events).toEqual([stage()]);
    const staged = replayAttachmentOperation(events);
    expect(staged.status).toBe("staged");
    expect(decideAttachmentOperation(staged, { type: "StageSupportAttachmentOperation", data: manifest() })).toEqual(
      [],
    );
    expect(
      decideAttachmentOperation(staged, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } }),
    ).toEqual([admitted()]);
    const partial = replayAttachmentOperation([stage(), admitted(), settled(), stored()]);
    expect(partial.status).toBe("partially-stored");
    expect(decideAttachmentOperation(partial, { type: "RecordSupportAttachmentStored", data: { index: 0 } })).toEqual(
      [],
    );
    expect(replayAttachmentOperation([stage(), stored(), stored(1)]).status).toBe("stored");
    expect(() =>
      decideAttachmentOperation(partial, { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 2 } }),
    ).toThrow();
  });

  it.each(["owner", "order", "bytes", "profile", "fingerprint"])(
    "changed %s retry conflicts before an append",
    (field) => {
      const changed =
        field === "owner"
          ? createAttachmentManifest({
              owner: { ...owner, accountId: "acc_other" },
              profile: fingerprint.profile,
              encoderFingerprint: fingerprint,
              images,
            })
          : field === "order"
            ? createAttachmentManifest({
                owner,
                profile: fingerprint.profile,
                encoderFingerprint: fingerprint,
                images: [...images].reverse(),
              })
            : field === "bytes"
              ? createAttachmentManifest({
                  owner,
                  profile: fingerprint.profile,
                  encoderFingerprint: fingerprint,
                  images: [images[0], { ...images[1], canonicalSha256: "c".repeat(64) }],
                })
              : field === "profile"
                ? { ...manifest(), profile: "other" }
                : createAttachmentManifest({
                    owner,
                    profile: fingerprint.profile,
                    encoderFingerprint: { ...fingerprint, sharp: "other" },
                    images,
                  });
      expect(() =>
        decideAttachmentOperation(replayAttachmentOperation([stage()]), {
          type: "StageSupportAttachmentOperation",
          data: changed,
        }),
      ).toThrow();
    },
  );

  it("ambiguous admissions remain unresolved, can converge by pre-read, and count only actual settlements", () => {
    const state = replayAttachmentOperation([stage(), admitted(), admitted(0, 2), settled(0, 2), stored()]);
    expect(state.attempts[0]).toEqual([
      { attempt: 1, outcome: null },
      { attempt: 2, outcome: "completed" },
    ]);
    expect(
      decideAttachmentOperation(state, {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 2, outcome: "completed" },
      }),
    ).toEqual([]);
    expect(() =>
      decideAttachmentOperation(state, {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 2, outcome: "failed" },
      }),
    ).toThrow();
  });

  it.each([[], [stage()], [stage(), stored()], [stage(), stored(), stored(1)]].map((history) => ({ history })))(
    "cleanup is terminal from every prior state %#",
    ({ history }) => {
      const events = decideAttachmentOperation(replayAttachmentOperation(history), {
        type: "RequireSupportAttachmentCleanup",
        data: cleanup.data,
      });
      const state = replayAttachmentOperation([...history, ...events]);
      expect(state.status).toBe("cleanup-required");
      expect(decideAttachmentOperation(state, { type: "RequireSupportAttachmentCleanup", data: cleanup.data })).toEqual(
        [],
      );
      expect(() =>
        decideAttachmentOperation(state, { type: "AdmitSupportAttachmentPut", data: { index: 1, attempt: 1 } }),
      ).toThrow();
      expect(() =>
        decideAttachmentOperation(state, { type: "RecordSupportAttachmentStored", data: { index: 1 } }),
      ).toThrow();
    },
  );

  it.each(
    [
      [stored()],
      [admitted()],
      [settled()],
      [stage(), stage()],
      [stage(), settled()],
      [stage(), admitted(), admitted()],
      [stage(), admitted(0, 2)],
      [stage(), admitted(-1)],
      [stage(), admitted(2)],
      [stage(), stored(), stored()],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: "failed" } },
        admitted(1),
      ],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: "failed" } },
        stored(1),
      ],
      [stage(), stored(), admitted()],
      [stage(), admitted(), settled(), settled()],
      [
        stage(),
        admitted(),
        { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: ["completed"] } },
      ],
      [stage(), { type: "support.attachment-operation.cleanup-required", data: { reason: ["verification-conflict"] } }],
      [stage(), cleanup, admitted()],
      [stage(), cleanup, stored()],
      [stage(), cleanup, stage()],
      [{ type: "support.attachment-operation.reference-claimed", data: {} }],
      [{ type: "support.attachment-operation.cleanup-claimed", data: {} }],
      [{ type: "unknown", data: {} }],
      [{ ...stage(), data: { ...manifest(), manifestFingerprint: "0".repeat(64) } }],
      [{ ...stage(), data: { ...manifest(), extra: true } }],
      [{ ...stage(), data: { ...manifest(), items: [{ ...manifest().items[0], index: 1 }] } }],
      [{ ...stage(), data: { ...manifest(), items: [{ ...manifest().items[0], attachmentId: "sea_random" }] } }],
    ].map((history) => ({ history })),
  )("rejects poisoned history %# instead of normalizing it into authority", ({ history }) => {
    expect(() => replayAttachmentOperation(history as AttachmentOperationEvent[])).toThrow();
  });
});

describe("Support Attachment Operation cleanup claims (AC-E6)", () => {
  const binding = { bindingId: "cleanup-a", bindingRevision: 2 };
  const now = "2026-10-15T12:00:00.000Z";
  const authority = { ...binding, now, lastPutAdmittedAt: null };
  const claimData = (attempt = 1, overrides: Record<string, unknown> = {}) => ({
    attempt,
    manifestFingerprint: manifest().manifestFingerprint,
    ...binding,
    claimedAt: now,
    ...overrides,
  });
  const claimed = (attempt = 1): AttachmentOperationEvent => ({
    type: "support.attachment-operation.cleanup-claimed",
    data: claimData(attempt) as never,
  });
  const deleted = (attempt = 1): AttachmentOperationEvent => ({
    type: "support.attachment-operation.deleted-unreferenced",
    data: { attempt },
  });
  const failed = (attempt = 1): AttachmentOperationEvent => ({
    type: "support.attachment-operation.cleanup-failed",
    data: { attempt, reason: "delete-failed" },
  });
  const required = (reason = "abandoned"): AttachmentOperationEvent => ({
    type: "support.attachment-operation.cleanup-required",
    data: { reason } as never,
  });
  const referenceClaim = {
    type: "ClaimSupportAttachmentReference",
    data: { evidenceId: "sev_case", attachments: attachmentManifestReferences(manifest()), submittedAt: now },
  } as const;
  const claim = (history: readonly AttachmentOperationEvent[], data = claimData(), auth: unknown = authority) =>
    decideAttachmentOperation(
      replayAttachmentOperation(history),
      { type: "ClaimSupportAttachmentCleanup", data: data as never },
      (auth ?? undefined) as never,
    );

  it("pins the grace window to the storage deadline plus five minutes", () => {
    expect(SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS).toBe(SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS + 5 * 60_000);
  });

  it.each(["human-request", "abandoned", "put-failed", "verification-absent", "verification-conflict"])(
    "records CleanupRequired(%s), claims, deletes and stays terminal",
    (reason) => {
      const base = [stage(), stored(), stored(1)];
      const requiredEvents = decideAttachmentOperation(replayAttachmentOperation(base), {
        type: "RequireSupportAttachmentCleanup",
        data: { reason } as never,
      });
      const history = [...base, ...requiredEvents];
      const claimEvents = claim(history);
      expect(claimEvents).toEqual([claimed()]);
      const claimedState = replayAttachmentOperation([...history, ...claimEvents]);
      expect(claimedState.status).toBe("cleanup-claimed");
      expect(claimedState.cleanupClaim).toEqual(claimData());
      const confirmed = decideAttachmentOperation(claimedState, {
        type: "ConfirmSupportAttachmentDeleted",
        data: { attempt: 1 },
      });
      const complete = [...history, ...claimEvents, ...confirmed];
      const terminal = replayAttachmentOperation(complete);
      expect(terminal.status).toBe("deleted-unreferenced");
      expect(
        decideAttachmentOperation(terminal, { type: "ConfirmSupportAttachmentDeleted", data: { attempt: 1 } }),
      ).toEqual([]);
      expect(
        decideAttachmentOperation(terminal, { type: "RequireSupportAttachmentCleanup", data: { reason: "abandoned" } }),
      ).toEqual([]);
      for (const command of [
        { type: "AdmitSupportAttachmentPut", data: { index: 0, attempt: 1 } },
        { type: "RecordSupportAttachmentStored", data: { index: 0 } },
        { type: "StageSupportAttachmentOperation", data: manifest() },
        referenceClaim,
        { type: "RecordSupportAttachmentCleanupFailed", data: { attempt: 1, reason: "delete-failed" } },
      ])
        expect(() => decideAttachmentOperation(terminal, command as never)).toThrow();
      expect(() => claim(complete, claimData(2))).toThrow("cleanup-not-eligible");
    },
  );

  it("rejects before-stage cleanup events and a claim without a manifest", () => {
    for (const event of [claimed(), deleted(), failed()])
      expect(() => replayAttachmentOperation([event])).toThrow("invalid-operation-history");
    expect(() => claim([required()])).toThrow();
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation([]), {
        type: "ConfirmSupportAttachmentDeleted",
        data: { attempt: 1 },
      }),
    ).toThrow();
  });

  const otherOwnerFingerprint = createAttachmentManifest({
    owner: { ...owner, accountId: "acc_other" },
    profile: fingerprint.profile,
    encoderFingerprint: fingerprint,
    images,
  }).manifestFingerprint;
  it.each([
    ["the wrong owner's manifest", { manifestFingerprint: otherOwnerFingerprint }],
    ["a changed fingerprint", { manifestFingerprint: "0".repeat(64) }],
    ["a skipped attempt", { attempt: 2 }],
    ["a non-canonical instant", { claimedAt: "2026-10-15T12:00:00Z" }],
    ["an invalid binding id", { bindingId: "Cleanup_A" }],
    ["an extra field", { extra: true }],
  ])("rejects a claim with %s", (_label, overrides) => {
    const data = claimData(1, overrides);
    const history = [stage(), stored(), stored(1), required()];
    const auth = {
      ...authority,
      ...("claimedAt" in overrides ? { now: overrides.claimedAt } : {}),
      ...("bindingId" in overrides ? { bindingId: overrides.bindingId } : {}),
    };
    expect(() => claim(history, data, auth)).toThrow();
    expect(() =>
      replayAttachmentOperation([...history, { type: "support.attachment-operation.cleanup-claimed", data } as never]),
    ).toThrow("invalid-operation-history");
  });

  it.each([
    ["no authority", null],
    ["another binding", { ...authority, bindingId: "cleanup-b" }],
    ["an older binding revision", { ...authority, bindingRevision: 1 }],
    ["a different claim instant", { ...authority, now: "2026-10-15T12:00:01.000Z" }],
  ])("rejects a claim with %s (mutant: authority-free claim)", (_label, auth) => {
    expect(() => claim([stage(), stored(), stored(1), required()], claimData(), auth)).toThrow("cleanup-unauthorized");
  });

  it("an admitted put blocks the claim after grace and an absent read until it settles (mutant: pending writer ignored)", () => {
    const pending = [stage(), admitted(), required("human-request")];
    const lastPutAdmittedAt = "2026-10-15T11:00:00.000Z";
    expect(() => claim(pending, claimData(), { ...authority, lastPutAdmittedAt })).toThrow("cleanup-not-eligible");
    expect(() =>
      replayAttachmentOperation([
        ...pending,
        { type: "support.attachment-operation.cleanup-claimed", data: claimData() } as never,
      ]),
    ).toThrow("invalid-operation-history");
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation(pending), {
        type: "AdmitSupportAttachmentPut",
        data: { index: 1, attempt: 1 },
      }),
    ).toThrow("operation-terminal");
    const settledEvents = decideAttachmentOperation(replayAttachmentOperation(pending), {
      type: "SettleSupportAttachmentPut",
      data: { index: 0, attempt: 1, outcome: "completed" },
    });
    expect(settledEvents).toEqual([settled()]);
    const history = [...pending, ...settledEvents];
    expect(
      decideAttachmentOperation(replayAttachmentOperation(history), {
        type: "SettleSupportAttachmentPut",
        data: { index: 0, attempt: 1, outcome: "completed" },
      }),
    ).toEqual([]);
    const at = (offsetMs: number) =>
      new Date(Date.parse(lastPutAdmittedAt) + SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS + offsetMs).toISOString();
    expect(() =>
      claim(history, claimData(1, { claimedAt: at(-1) }), { ...authority, now: at(-1), lastPutAdmittedAt }),
    ).toThrow("cleanup-not-eligible");
    expect(
      claim(history, claimData(1, { claimedAt: at(0) }), { ...authority, now: at(0), lastPutAdmittedAt }),
    ).toHaveLength(1);
  });

  it("lets a pending sibling settle after a failed put so cleanup converges", () => {
    const history = [
      stage(),
      admitted(0),
      admitted(1),
      { type: "support.attachment-operation.put-settled", data: { index: 0, attempt: 1, outcome: "failed" } },
      required("put-failed"),
      settled(1),
    ] as AttachmentOperationEvent[];
    expect(claim(history)).toEqual([claimed()]);
  });

  it("rejects puts after a claim or terminal, unfenced confirmations and dual terminals", () => {
    const history = [stage(), stored(), stored(1), required(), claimed()];
    for (const event of [admitted(), settled(), stored(), required(), deleted(2), failed(2), claimed()])
      expect(() => replayAttachmentOperation([...history, event])).toThrow("invalid-operation-history");
    expect(() => replayAttachmentOperation([stage(), stored(), stored(1), required(), deleted()])).toThrow();
    expect(() => replayAttachmentOperation([stage(), stored(), stored(1), required(), failed()])).toThrow();
    expect(() => replayAttachmentOperation([...history, deleted(), deleted()])).toThrow();
    expect(() => replayAttachmentOperation([...history, deleted(), failed()])).toThrow();
    expect(() => replayAttachmentOperation([...history, deleted(), claimed(2)])).toThrow();
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation(history), {
        type: "ConfirmSupportAttachmentDeleted",
        data: { attempt: 2 },
      }),
    ).toThrow();
    const referenced = [
      stage(),
      stored(),
      stored(1),
      { type: "support.attachment-operation.reference-claimed", data: referenceClaim.data },
      { type: "support.attachment-operation.referenced", data: { evidenceId: "sev_case" } },
    ] as AttachmentOperationEvent[];
    for (const event of [required(), claimed(), deleted(), failed()])
      expect(() => replayAttachmentOperation([...referenced, event])).toThrow();
    expect(() => claim(referenced)).toThrow("cleanup-not-eligible");
    expect(() =>
      decideAttachmentOperation(replayAttachmentOperation(referenced), {
        type: "RequireSupportAttachmentCleanup",
        data: { reason: "human-request" },
      }),
    ).toThrow("operation-terminal");
  });

  it("a failed attempt returns to CleanupRequired; retry or takeover reclaims with the next attempt only", () => {
    const history = [stage(), stored(), stored(1), required(), claimed(), failed()];
    const state = replayAttachmentOperation(history);
    expect(state.status).toBe("cleanup-required");
    expect(state.cleanupClaim).toBeNull();
    expect(() => claim(history, claimData(1))).toThrow();
    expect(claim(history, claimData(2))).toEqual([claimed(2)]);
    const takeover = [stage(), stored(), stored(1), required(), claimed()];
    expect(claim(takeover, claimData(2))).toEqual([claimed(2)]);
    expect(() => replayAttachmentOperation([...takeover, claimed(2), deleted(1)])).toThrow("invalid-operation-history");
    expect(replayAttachmentOperation([...takeover, claimed(2), deleted(2)]).status).toBe("deleted-unreferenced");
  });

  it("rejects a delayed reference claim after cleanup was required or claimed", () => {
    for (const history of [
      [stage(), stored(), stored(1), required()],
      [stage(), stored(), stored(1), required(), claimed()],
    ])
      expect(() => decideAttachmentOperation(replayAttachmentOperation(history), referenceClaim)).toThrow(
        "operation-terminal",
      );
  });

  it("fresh, upgraded, replayed and boot-twice histories converge to one state", () => {
    // A history written before cleanup claims existed (S-D2 reasons only) replays unchanged and stays claimable.
    const upgraded = [stage(), admitted(), settled(), stored(), cleanup];
    const fresh = replayAttachmentOperation(upgraded);
    expect(fresh.status).toBe("cleanup-required");
    const complete = [...upgraded, ...claim(upgraded)];
    const once = replayAttachmentOperation(complete);
    const twice = replayAttachmentOperation(JSON.parse(JSON.stringify(complete)) as AttachmentOperationEvent[]);
    expect(twice).toEqual(once);
    expect(
      decideAttachmentOperation(once, { type: "RequireSupportAttachmentCleanup", data: { reason: "abandoned" } }),
    ).toEqual([]);
  });
});
