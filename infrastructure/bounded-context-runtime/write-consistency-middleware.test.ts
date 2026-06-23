import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, decodeCommitReceipt, encodeCommitReceipt } from "@chase-sets/http/responses";
import { recordCommittedEvents, type StoredEvent } from "@chase-sets/event-core";
import { attachWriteConsistencyMiddleware } from "./index";

function storedEvent(input: Readonly<{ id: string; streamId: string; globalPosition: string }>): StoredEvent {
  return {
    eventId: input.id as StoredEvent["eventId"],
    streamId: input.streamId,
    streamVersion: 1,
    globalPosition: input.globalPosition as StoredEvent["globalPosition"],
    tenantId: "tnt_test" as StoredEvent["tenantId"],
    eventType: "marketplace.listing.published",
    payload: {},
    metadata: {},
    occurredAt: "2026-05-29T00:00:00.000Z" as StoredEvent["occurredAt"],
    recordedAt: "2026-05-29T00:00:00.000Z" as StoredEvent["recordedAt"],
    performedByUserId: "usr_test" as StoredEvent["performedByUserId"],
    forAccountId: "acc_test" as StoredEvent["forAccountId"],
  };
}

describe("bounded context write consistency middleware", () => {
  it("attaches commit metadata headers to mutation responses", async () => {
    const app = new Hono();

    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/marketplace" }]);
    app.post("/api/marketplace/account/listings", (context) => {
      recordCommittedEvents([
        storedEvent({
          id: "evt_listing_published",
          streamId: "marketplace.listing-lst_1",
          globalPosition: "42",
        }),
      ]);

      return context.json({ id: "lst_1", status: "published" }, 201);
    });

    const response = await app.request("/api/marketplace/account/listings", { method: "POST" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Chase-Sets-Consistency")).toBe("eventual");
    expect(response.headers.get("Chase-Sets-Commit-Position")).toBe("42");
    expect(response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe("evt_listing_published");
    expect(decodeCommitReceipt(response.headers.get("Chase-Sets-Commit-Receipt"))).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_listing_published"],
      },
    ]);
  });

  it("does not attach commit metadata headers to reads", async () => {
    const app = new Hono();

    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/marketplace" }]);
    app.get("/api/marketplace/items/charizard", (context) => context.json({ id: "charizard" }));

    const response = await app.request("/api/marketplace/items/charizard");

    expect(response.status).toBe(200);
    expect(response.headers.get("Chase-Sets-Consistency")).toBeNull();
    expect(response.headers.get("Chase-Sets-Commit-Receipt")).toBeNull();
  });

  it("merges existing upstream commit receipts with local mutation metadata", async () => {
    const app = new Hono();

    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/auth" }]);
    app.post("/api/auth/register", (context) => {
      recordCommittedEvents([
        storedEvent({
          id: "evt_session_started",
          streamId: "auth.session-ses_1",
          globalPosition: "71",
        }),
      ]);

      return context.json({ sessionId: "ses_1", status: "started" }, 201, {
        "Chase-Sets-Consistency": "eventual",
        "Chase-Sets-Commit-Event-Ids": "evt_identity_account_created",
        [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt([
          {
            sourceContextName: "identity",
            maxGlobalPosition: "51",
            eventIds: ["evt_identity_account_created"],
          },
        ]),
      });
    });

    const response = await app.request("/api/auth/register", { method: "POST" });

    expect(response.status).toBe(201);
    expect(response.headers.get("Chase-Sets-Consistency")).toBe("eventual");
    expect(response.headers.get("Chase-Sets-Commit-Position")).toBe("71");
    expect(response.headers.get("Chase-Sets-Commit-Event-Ids")).toBe(
      "evt_identity_account_created,evt_session_started",
    );
    expect(decodeCommitReceipt(response.headers.get(CHASE_SETS_COMMIT_RECEIPT_HEADER))).toEqual([
      {
        sourceContextName: "auth",
        maxGlobalPosition: "71",
        eventIds: ["evt_session_started"],
      },
      {
        sourceContextName: "identity",
        maxGlobalPosition: "51",
        eventIds: ["evt_identity_account_created"],
      },
    ]);
  });
});
