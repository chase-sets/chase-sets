// @vitest-environment node
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SupportApiEnv } from "./http";
import { createAccountSupportRequestRoutes } from "./route";
import type { SupportRequestServices } from "./runtime";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { createSupportRequestRuntime } from "./runtime";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { File as NodeFile } from "node:buffer";
import { decideSupportRequest, initialSupportRequestState } from "../domain/domain";
import { guestCheckoutActorThroughAuth, mintEvidenceActorThroughIdentity } from "../tests/evidence-access-identity";
import {
  multipartRequest,
  nativeFormData,
  openingPhotoForm,
  streamedIntakeRequest,
} from "../tests/attachment-intake.test-support";
import { SUPPORT_ATTACHMENT_INTAKE_MAX_BYTES, SUPPORT_ATTACHMENT_INTAKE_DEADLINE_MS } from "./attachment-intake";

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
) {
  const app = new Hono<SupportApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", evidenceActor("platform-admin", permissions, false, "acc_operator"));
    c.set("context", {
      tenantId: "tnt_identity",
      audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" },
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
      form.append("attachments", new NodeFile([photo], `${index}.jpg`, { type: "image/jpeg" }) as File);
    const request = await multipartRequest("http://localhost/support-requests/sup_case/attachments", form, {
      "x-support-attachment-operation-id": "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    const response = await attachmentApp(
      fixture.runtime,
      evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
    ).request(request);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await response.json()).attachments).toHaveLength(5);
    expect(fixture.storage.putObject).toHaveBeenCalledTimes(5);
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
        expect(fixture.storage.putObject).not.toHaveBeenCalled();
        expect(fixture.storage.getObject).not.toHaveBeenCalled();
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
      expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
    it(`validates optional operation header ${String(header)} after authorization, before parsing`, async () => {
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
        expect(parse).toHaveBeenCalledTimes(
          header === undefined || header === "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV" ? 1 : 0,
        );
        expect((await response.json()).error.code).toBe(
          header === undefined || header === "sao_01ARZ3NDEKTSV4RRFFQ69G5FAV"
            ? "invalid-content"
            : "invalid-operation-id",
        );
        expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
    });
    const parse = vi.spyOn(request, "formData");
    const response = await attachmentApp(
      fixture.runtime,
      evidenceActor("owner", ["support.manage"], false, "acc_buyer"),
    ).request(request);
    expect(response.status).toBe(411);
    expect(parse).not.toHaveBeenCalled();
    expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
                new NodeFile(
                  [readFileSync("features/support-requests/api/__fixtures__/evidence/photo-orientation-6-p3-xmp.jpg")],
                  "photo.jpg",
                  { type: "image/jpeg" },
                ) as File,
              );
              const intakeRequest = action === "upload" ? await multipartRequest(request.url, form) : request;
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
                expect(fixture.storage.putObject).not.toHaveBeenCalled();
                expect(fixture.storage.getObject).not.toHaveBeenCalled();
              }
              expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(
                1,
              );
              expect(fixture.allEvents.at(-1)?.payload).toMatchObject({
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
      expect(fixture.storage.getObject).not.toHaveBeenCalled();
      expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
      expect(fixture.storage.getObject).not.toHaveBeenCalled();
      expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
    expect(fixture.storage.getObject).toHaveBeenCalledTimes(1);
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
            attachments: ["att_1"],
          }),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
      const attempts = fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case");
      expect(attempts).toHaveLength(1);
      expect(attempts[0].payload).toMatchObject({ decision: "allowed" });
      expect(fixture.storage.getObject).not.toHaveBeenCalled();
      expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
          attachments: ["att_1"],
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
      expect(fixture.storage.getObject).not.toHaveBeenCalled();
      expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
                  attachments: ["att_1"],
                }),
              },
            );
            expect(response.status).toBe(
              !permitted ? 403 : operations ? (granted ? 200 : participant ? 403 : 404) : participant ? 200 : 404,
            );
            expect(fixture.allEvents.filter((e) => e.streamId === "support.evidence-access-sup_case")).toHaveLength(1);
            expect(fixture.storage.getObject).not.toHaveBeenCalled();
            expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
    expect(fixture.storage.getObject).toHaveBeenCalledTimes(1);
  });

  it("seller participation authorizes downloads but not audit reads without an assignment", async () => {
    const fixture = await attachmentRouteFixture();
    const app = attachmentApp(fixture.runtime, evidenceActor("viewer", ["support.view"], false, "acc_seller"));
    expect((await app.request("/support-requests/sup_case/attachments/sea_photo")).status).toBe(200);
    expect(fixture.allEvents.at(-1)?.payload).toMatchObject({ participation: "seller", reason: "participant" });
    expect((await app.request("/support-requests/ops/sup_case/attachments/access-audit")).status).toBe(403);
    expect(fixture.storage.getObject).toHaveBeenCalledTimes(1);
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
    expect(fixture.storage.getObject).not.toHaveBeenCalled();
    expect(fixture.storage.putObject).not.toHaveBeenCalled();
  });

  it("provider GET observes committed authorization; later failure cannot claim delivery or expose markers", async () => {
    const fixture = await attachmentRouteFixture();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.storage.getObject.mockImplementationOnce(async () => {
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
    expect(fixture.storage.getObject).not.toHaveBeenCalled();
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
    expect(fixture.storage.putObject).not.toHaveBeenCalled();
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
    await next();
  });
  app.route("/support-requests", createAccountSupportRequestRoutes(runtime));
  return app;
}

async function attachmentRouteFixture(exists = true, buyerAccountId = "acc_buyer") {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const body = new Uint8Array([0xff, 0xd8, 0xff]);
  const reference = `support-attachment:v1:sea_photo:${createHash("sha256").update(body).digest("hex")}:jpg`;
  if (exists)
    await eventStore.appendToStream({
      streamId: "support.support-request-sup_case",
      expectedVersion: "any",
      context: {
        tenantId: "tnt_identity",
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
          flowType: "product-not-received",
          openedAt: "2026-10-12T00:00:00.000Z",
          orderTotalAmount: "10.00",
          orderReturnContext: [],
        } as never).map((event) => ({ eventType: event.type, payload: event.data })),
        {
          eventType: "support.support-request.evidence-submitted",
          payload: {
            evidence: { attachments: [reference], submittedAt: "2026-10-12T00:00:00.000Z" },
            updatedChecklist: [],
          },
        },
      ],
    });
  const storage = {
    putObject: vi.fn(async (input: { key: string }) => ({ key: input.key, publicUrl: "private" })),
    getObject: vi.fn(async () => ({ body, contentType: "image/jpeg" })),
    deleteObjects: vi.fn(),
  };
  const runtime = createSupportRequestRuntime({
    eventStore,
    db: { query: vi.fn(async () => ({ rows: [supportRequestDetail()] })) } as never,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    attachmentStorage: storage,
  });
  return { runtime, eventStore, allEvents, storage };
}

function supportRequestDetail() {
  return {
    support_request_id: "sup_1",
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
  };
}

function createServices(overrides: Partial<SupportRequestServices> = {}): SupportRequestServices {
  return {
    commandHandler: vi.fn(),
    listFlowDefinitions: vi.fn(async () => []),
    getSupportOrderContext: vi.fn(),
    openSupportRequest: vi.fn(),
    uploadAttachments: vi.fn(),
    getAttachment: vi.fn(),
    getEvidenceAccessAudit: vi.fn(),
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
    listSupportOperationsQueue: vi.fn(),
    listBuyerSupportRequests: vi.fn(),
    listSellerSupportRequests: vi.fn(),
    getAccountSupportRequest: vi.fn(),
    getSupportOperationsRequest: vi.fn(async () => supportRequestDetail()),
    projectors: [],
    ...overrides,
  } as unknown as SupportRequestServices;
}

describe("support request routes", () => {
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
    const command = vi.fn(async () => ({
      supportRequestId: expected.id,
      version: expected.version,
    }));
    const services = createServices({ [methodName]: command } as Partial<SupportRequestServices>);

    const response = await buildApp(services).request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(methodName === "openSupportRequest" ? 201 : 200);
    await expect(response.json()).resolves.toEqual(expected);
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
    const listSupportOperationsQueue = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSupportOperationsQueue });

    const response = await buildApp(services).request(
      "/support-requests/ops?limit=25&offset=50&status=ready-for-support&priority=urgent&search=ord_1",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], total: 0, count: 0 });
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
    const response = await buildApp(services).request("/support-requests/ops/sup_1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      support_request_id: "sup_1",
      buyer_account_id: "acc_buyer",
      seller_account_id: "acc_seller",
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
