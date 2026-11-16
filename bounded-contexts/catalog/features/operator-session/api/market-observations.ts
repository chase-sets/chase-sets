import type { EventStore } from "@chase-sets/event-core/event-store";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { redactProviderCredentialReadinessEvidence } from "@chase-sets/provider-credentials";
import {
  PART_TEXT_MAX_BYTES,
  assembleAdmittedTcgplayerMarketObservationBatch,
  maxBatchTextBytes,
  maxPartCount,
  parseAdmissionPayload,
  parsePartPayload,
  tcgplayerMarketObservationBatchAdmitted,
  tcgplayerMarketObservationPartRecorded,
  type SecondaryProduct,
  type TcgplayerMarketObservationBatch,
  type TcgplayerMarketObservationPartPayload,
  type TcgplayerMarketObservationAdmissionPayload,
  type TcgplayerMarketObservationRequest,
  type TcgplayerMarketObservationRequestSource,
} from "@chase-sets/tcgplayer-market-observations";
import { OperatorSessionRequestError, readBody } from "./request";
import { operatorExtensionContext, type ObservationGrant } from "./set-name-observations";

export const CLIENT_CLOCK_TOLERANCE_MS = 120_000;
export const MARKET_OBSERVATION_BODY_MAX_BYTES = 2 * PART_TEXT_MAX_BYTES + 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const headers = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const refuse = (code: string, status = 400): never => {
  throw new OperatorSessionRequestError(code, status);
};
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// Parts are durable before assembly. Reject credential material and raw seller identity
// before appending, including markers split across a part boundary.
function privateText(text: string) {
  return (
    redactProviderCredentialReadinessEvidence({ text }).text !== text ||
    /cookie|bearer|seller[-_ ]?name|\\u[0-9a-f]{4}/i.test(text)
  );
}

function validateEndpointClocks(
  batch: TcgplayerMarketObservationBatch,
  request: TcgplayerMarketObservationRequest,
  databaseNow: string,
) {
  if (batch.phase !== "secondary") return;
  const minimum = Date.parse(request.issuedAt) - CLIENT_CLOCK_TOLERANCE_MS;
  const maximum = Date.parse(databaseNow) + CLIENT_CLOCK_TOLERANCE_MS;
  for (const product of batch.products as readonly SecondaryProduct[])
    for (const endpoint of [product.sales, product.listings, product.history])
      for (const instant of [endpoint.requestedAt, endpoint.responseObservedAt])
        if (instant !== null && (Date.parse(instant) < minimum || Date.parse(instant) > maximum))
          refuse("invalid-body");
}

export type MarketObservationDeps = Readonly<{
  authorizeObservationGrant: (request: Request) => Promise<ObservationGrant>;
  requestSource: TcgplayerMarketObservationRequestSource | undefined;
  store: EventStore;
  databaseNow: () => Promise<string>;
}>;

// Issue: https://github.com/chase-sets/chase-sets/issues/9920
export function createMarketObservationRoutes(deps: MarketObservationDeps) {
  async function currentRequest() {
    const source = deps.requestSource;
    if (!source) return refuse("request-source-unavailable", 503);
    return source.currentRequest();
  }
  async function history(batchId: string, request: TcgplayerMarketObservationRequest) {
    const events: StoredEvent[] = [];
    const cap = maxPartCount(request) + 2;
    for (;;) {
      const page = await deps.store.readStream({
        streamId: `catalog.operator-observation-batch-${batchId}`,
        fromVersion: events.length + 1,
        limit: Math.min(500, cap - events.length),
      });
      events.push(...page);
      if (events.length >= cap) refuse("batch-closed", 409);
      if (page.length === 0) break;
    }
    let admitted = false;
    for (const [index, event] of events.entries()) {
      if (event.streamVersion !== index + 1 || admitted) refuse("batch-closed", 409);
      try {
        if (event.eventType === tcgplayerMarketObservationBatchAdmitted) {
          const admission = parseAdmissionPayload(event.payload, request);
          if (admission.batchId !== batchId) refuse("batch-closed", 409);
          admitted = true;
        } else {
          if (event.eventType !== tcgplayerMarketObservationPartRecorded) refuse("batch-closed", 409);
          const part = parsePartPayload(event.payload, request);
          if (part.batchId !== batchId || part.partIndex !== index || privateText(part.text))
            refuse("batch-closed", 409);
        }
      } catch {
        refuse("batch-closed", 409);
      }
    }
    if (admitted) {
      try {
        const batch = await assembleAdmittedTcgplayerMarketObservationBatch(
          events.map((event) => ({ streamVersion: event.streamVersion, data: event.payload })),
          request,
        );
        validateEndpointClocks(batch, request, await deps.databaseNow());
      } catch {
        refuse("batch-closed", 409);
      }
    }
    return { events, admitted };
  }

  async function execute(
    kind: "current" | "part" | "complete",
    input: Request,
    batchId = "",
    index = "",
  ): Promise<Response> {
    try {
      if (
        kind !== "current" &&
        (!UUID.test(batchId) ||
          (kind === "part" && (!/^(0|[1-9][0-9]{0,15})$/.test(index) || !Number.isSafeInteger(Number(index)))))
      )
        refuse("invalid-route");
      const grant = await deps.authorizeObservationGrant(input);
      if (kind === "current") return json({ request: await currentRequest() });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(input, kind === "part" ? MARKET_OBSERVATION_BODY_MAX_BYTES : 1024));
      } catch (error) {
        if (error instanceof OperatorSessionRequestError) throw error;
        refuse("invalid-body");
      }
      if (
        !closed(
          body,
          kind === "part" ? ["requestId", "phase", "text"] : ["requestId", "phase", "partCount", "textBytes", "digest"],
        ) ||
        typeof body.requestId !== "string" ||
        !UUID.test(body.requestId) ||
        (body.phase !== "price-points" && body.phase !== "secondary")
      )
        refuse("invalid-body");
      const value = body as Record<string, unknown>;
      if (kind === "part") {
        if (
          typeof value.text !== "string" ||
          value.text.length < 1 ||
          value.text.length > PART_TEXT_MAX_BYTES ||
          !/^[\x00-\x7f]*$/.test(value.text) ||
          privateText(value.text)
        )
          refuse("invalid-body");
      } else if (
        !positive(value.textBytes) ||
        Math.ceil(value.textBytes / PART_TEXT_MAX_BYTES) !== value.partCount ||
        typeof value.digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.digest)
      )
        refuse("invalid-body");
      const request = await currentRequest();
      if (!request || request.requestId !== value.requestId || request.phase !== value.phase)
        refuse("request-not-current", 409);
      const current = request!;
      if (
        (kind === "part" && Number(index) >= maxPartCount(current)) ||
        (kind === "complete" && (value.textBytes as number) > maxBatchTextBytes(current))
      )
        refuse("batch-too-large", 413);

      for (let attempt = 0; attempt < 2; attempt++) {
        const { events, admitted } = await history(batchId, current);
        const streamId = `catalog.operator-observation-batch-${batchId}`;
        let payload: TcgplayerMarketObservationPartPayload | TcgplayerMarketObservationAdmissionPayload;
        let eventType: string;
        if (kind === "part") {
          if (admitted) refuse("batch-closed", 409);
          const part = parsePartPayload({ batchId, partIndex: Number(index), ...value }, current);
          const prior = events[part.partIndex];
          if (prior) {
            if (prior.payload.text === part.text) return json({ code: "part-already-recorded" });
            refuse("part-conflict", 409);
          }
          if (events.length !== part.partIndex) refuse("part-out-of-order", 409);
          if (events.some((event) => (event.payload.text as string).length !== PART_TEXT_MAX_BYTES))
            refuse("part-conflict", 409);
          if (privateText(events.map((event) => event.payload.text as string).join("") + part.text))
            refuse("invalid-body");
          payload = part;
          eventType = tcgplayerMarketObservationPartRecorded;
        } else {
          if (admitted) {
            const prior = events.at(-1)!.payload;
            if (
              ["requestId", "phase", "partCount", "textBytes", "digest"].every((key) => prior[key] === value[key]) &&
              prior.grantId === grant.grantId &&
              prior.creatorUserId === grant.creatorUserId &&
              prior.creatorMembershipId === grant.creatorMembershipId
            )
              return json({ code: "already-admitted" });
            refuse("batch-closed", 409);
          }
          if (events.length !== value.partCount) refuse("part-out-of-order", 409);
          const admittedAt = await deps.databaseNow();
          try {
            payload = parseAdmissionPayload({ batchId, ...value, contractVersion: 1, ...grant, admittedAt }, current);
            const batch = await assembleAdmittedTcgplayerMarketObservationBatch(
              [
                ...events.map((event) => ({ streamVersion: event.streamVersion, data: event.payload })),
                { streamVersion: events.length + 1, data: payload },
              ],
              current,
            );
            validateEndpointClocks(batch, current, admittedAt);
          } catch {
            return refuse("invalid-body");
          }
          eventType = tcgplayerMarketObservationBatchAdmitted;
        }
        try {
          await deps.store.appendToStream({
            streamId,
            expectedVersion: events.length === 0 ? "no_stream" : events.length,
            context: operatorExtensionContext(grant),
            events: [{ eventType, payload }],
          });
          return json({ code: kind === "part" ? "part-recorded" : "admitted" });
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "concurrency_conflict") throw error;
          if (attempt === 1) refuse("part-conflict", 409);
        }
      }
      return json({ code: "part-conflict" }, 409);
    } catch (error) {
      return error instanceof OperatorSessionRequestError
        ? json({ code: error.code }, error.status)
        : json({ code: "observation-store-unavailable" }, 503);
    }
  }
  return {
    current: (request: Request) => execute("current", request),
    part: (request: Request, batchId: string, index: string) => execute("part", request, batchId, index),
    complete: (request: Request, batchId: string) => execute("complete", request, batchId),
  };
}
