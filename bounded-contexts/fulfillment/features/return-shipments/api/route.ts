import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { Hono } from "hono";
import type { FulfillmentApiEnv } from "../../../api";
import type { ReturnIntakeDiscrepancy, ReturnIntakeEvidenceAttachment } from "../domain/facility-intake";
import type { FulfillmentReturnShipmentServices } from "./runtime";
import { unidentifiedReturnPackageStreamId } from "./runtime";

function jsonError(code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 410 | 503) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requireIntakeAccess(
  c: { get(key: "actor"): FulfillmentApiEnv["Variables"]["actor"] },
  permission: "return-intake.view" | "return-intake.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return { actor: null, response: jsonError("authentication_required", "Authentication is required.", 401) };
  }
  if (!actor.permissions.includes(permission)) {
    return { actor: null, response: jsonError("authorization_forbidden", "Return intake access is required.", 403) };
  }
  return { actor, response: null };
}

function requireContext(c: { get(key: "context"): EventStoreContext | undefined }) {
  return c.get("context") ?? null;
}

function requiredFacilityId(value: unknown): string {
  return String(value ?? "").trim();
}

function isConcurrencyConflict(error: unknown): boolean {
  return (error as { code?: string }).code === "concurrency_conflict";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Return intake request failed.";
}

export function createReturnIntakeRoutes(services: FulfillmentReturnShipmentServices) {
  const app = new Hono<FulfillmentApiEnv>();

  app.get("/", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.view");
    if (access.response) return access.response;
    const facilityId = requiredFacilityId(c.req.query("facilityId"));
    if (!facilityId) return jsonError("validation_failed", "Facility is required.", 400);
    const [items, unidentified, metrics] = await Promise.all([
      services.listFacilityIntakeQueue(facilityId),
      services.listUnidentifiedPackages(facilityId),
      services.getIntakeMetrics(facilityId),
    ]);
    return c.json({ items, unidentified, metrics });
  });

  app.get("/resolve", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.view");
    if (access.response) return access.response;
    const facilityId = requiredFacilityId(c.req.query("facilityId"));
    const identifier = String(c.req.query("identifier") ?? "").trim();
    if (!facilityId || !identifier) return jsonError("validation_failed", "Facility and identifier are required.", 400);
    const result = await services.resolveForIntake(identifier, facilityId);
    if (result.outcome === "not-found") return c.json(result, 404);
    if (result.outcome === "ambiguous") return c.json(result, 409);
    return c.json({ ...result, version: await services.getReturnShipmentVersion(result.shipment.return_shipment_id) });
  });

  app.post("/evidence", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.manage");
    if (access.response) return access.response;
    try {
      const formData = await c.req.formData();
      const facilityId = requiredFacilityId(formData.get("facilityId"));
      const file = formData.get("evidence");
      if (!facilityId || !(file instanceof File)) {
        return jsonError("validation_failed", "Facility and evidence file are required.", 400);
      }
      const attachment = await services.uploadEvidence({
        facilityId,
        uploadedAt: new Date().toISOString(),
        upload: {
          body: new Uint8Array(await file.arrayBuffer()),
          contentType: file.type,
          filename: file.name || null,
        },
      });
      return c.json({ attachment }, 201);
    } catch (error) {
      const code = (error as { code?: string }).code;
      return jsonError(
        code ?? "evidence_upload_failed",
        errorMessage(error),
        code === "storage-unavailable" ? 503 : 400,
      );
    }
  });

  app.get("/evidence/:attachmentId", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.view");
    if (access.response) return access.response;
    const facilityId = requiredFacilityId(c.req.query("facilityId"));
    if (!facilityId) return jsonError("validation_failed", "Facility is required.", 400);
    const reference = await services.getEvidenceReference(c.req.param("attachmentId"), facilityId);
    if (!reference) return jsonError("not_found", "Evidence was not found.", 404);
    if (Date.parse(reference.retention_until) <= Date.now()) {
      return jsonError("evidence_expired", "Evidence retention has expired.", 410);
    }
    const object = await services.getEvidence(reference.storage_key);
    if (!object) return jsonError("not_found", "Evidence was not found.", 404);
    return new Response(
      object.body.buffer.slice(object.body.byteOffset, object.body.byteOffset + object.body.byteLength) as ArrayBuffer,
      {
        headers: {
          "cache-control": "private, no-store",
          "content-type": reference.content_type,
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      },
    );
  });

  app.post("/:returnShipmentId/complete", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.manage");
    if (access.response) return access.response;
    const context = requireContext(c);
    if (!context) return jsonError("authentication_required", "Authenticated command context is required.", 401);
    const body = (await c.req.json()) as Record<string, unknown>;
    const facilityId = requiredFacilityId(body.facilityId);
    const resolved = await services.resolveForIntake(c.req.param("returnShipmentId"), facilityId);
    if (resolved.outcome !== "resolved") {
      return jsonError("not_found", "Return shipment is not expected at this facility.", 404);
    }
    try {
      const evidence = (Array.isArray(body.evidence) ? body.evidence : []) as readonly ReturnIntakeEvidenceAttachment[];
      await services.verifyEvidence(facilityId, evidence);
      const result = await services.completeFacilityIntake({
        returnShipmentId: resolved.shipment.return_shipment_id,
        expectedVersion: Number.isInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined,
        context,
        command: {
          type: "CompleteReturnShipmentFacilityIntake",
          intake: {
            facilityId,
            stationId: String(body.stationId ?? ""),
            operatorUserId: access.actor.userId,
            receivedAt: String(body.receivedAt ?? new Date().toISOString()),
            packageCondition: String(body.packageCondition ?? "") as never,
            sealCondition: String(body.sealCondition ?? "") as never,
            measuredWeightOunces: body.measuredWeightOunces == null ? null : Number(body.measuredWeightOunces),
            evidence,
            discrepancies: (Array.isArray(body.discrepancies)
              ? body.discrepancies
              : []) as readonly ReturnIntakeDiscrepancy[],
            disposition: String(body.disposition ?? "") as never,
            custodyIdentifier: String(body.custodyIdentifier ?? ""),
            idempotencyKey: String(body.idempotencyKey ?? ""),
          },
          metadata: {
            correlationRemedyId: resolved.shipment.remedy_id as never,
            causationId: null,
            idempotencyKey: String(body.idempotencyKey ?? ""),
            policyVersion: "return-intake-v1",
          },
        },
      });
      return c.json({
        returnShipmentId: resolved.shipment.return_shipment_id,
        version: result.version,
        intake: result.state.facilityIntake,
        duplicate: result.newEvents.some(
          (event) => event.type === "fulfillment.return-shipment.duplicate-intake-scan-observed.v1",
        ),
      });
    } catch (error) {
      const storageUnavailable = (error as { code?: string }).code === "storage-unavailable";
      return jsonError(
        isConcurrencyConflict(error) ? "stale_intake" : "intake_failed",
        errorMessage(error),
        isConcurrencyConflict(error) ? 409 : storageUnavailable ? 503 : 400,
      );
    }
  });

  app.post("/:returnShipmentId/corrections", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.manage");
    if (access.response) return access.response;
    const context = requireContext(c);
    if (!context) return jsonError("authentication_required", "Authenticated command context is required.", 401);
    const body = (await c.req.json()) as Record<string, unknown>;
    const facilityId = requiredFacilityId(body.facilityId);
    const resolved = await services.resolveForIntake(c.req.param("returnShipmentId"), facilityId);
    if (resolved.outcome !== "resolved") return jsonError("not_found", "Return shipment was not found.", 404);
    try {
      const correctionId = String(body.correctionId ?? createId("ric"));
      const result = await services.commandHandler({
        streamId: services.streamIdFor(resolved.shipment.return_shipment_id),
        context,
        expectedVersion: Number.isInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined,
        command: {
          type: "CorrectReturnShipmentFacilityIntake",
          correction: {
            correctionId,
            reason: String(body.reason ?? ""),
            correctedByUserId: access.actor.userId,
            correctedAt: new Date().toISOString(),
            owner: body.owner == null ? null : String(body.owner),
            nextAction: body.nextAction == null ? null : String(body.nextAction),
            custodyIdentifier: body.custodyIdentifier == null ? null : String(body.custodyIdentifier),
          },
          metadata: {
            correlationRemedyId: resolved.shipment.remedy_id as never,
            causationId: null,
            idempotencyKey: correctionId,
            policyVersion: "return-intake-v1",
          },
        },
      });
      return c.json({ returnShipmentId: resolved.shipment.return_shipment_id, version: result.version });
    } catch (error) {
      return jsonError(
        isConcurrencyConflict(error) ? "stale_intake" : "correction_failed",
        errorMessage(error),
        isConcurrencyConflict(error) ? 409 : 400,
      );
    }
  });

  app.post("/unidentified", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.manage");
    if (access.response) return access.response;
    const context = requireContext(c);
    if (!context) return jsonError("authentication_required", "Authenticated command context is required.", 401);
    const body = (await c.req.json()) as Record<string, unknown>;
    const unidentifiedPackageId = String(body.unidentifiedPackageId ?? createId("urp"));
    try {
      const facilityId = requiredFacilityId(body.facilityId);
      const evidence = (Array.isArray(body.evidence) ? body.evidence : []) as readonly ReturnIntakeEvidenceAttachment[];
      await services.verifyEvidence(facilityId, evidence);
      const result = await services.unidentifiedPackageCommandHandler({
        streamId: unidentifiedReturnPackageStreamId(unidentifiedPackageId),
        context,
        command: {
          type: "RecordUnidentifiedReturnPackage",
          unidentifiedPackageId: unidentifiedPackageId as never,
          facilityId,
          stationId: String(body.stationId ?? ""),
          operatorUserId: access.actor.userId,
          receivedAt: String(body.receivedAt ?? new Date().toISOString()),
          packageCondition: String(body.packageCondition ?? ""),
          sealCondition: String(body.sealCondition ?? ""),
          measuredWeightOunces: body.measuredWeightOunces == null ? null : Number(body.measuredWeightOunces),
          evidence,
          custodyIdentifier: String(body.custodyIdentifier ?? ""),
          notes: body.notes == null ? null : String(body.notes),
          owner: String(body.owner ?? ""),
          nextAction: String(body.nextAction ?? ""),
        },
      });
      return c.json({ unidentifiedPackageId, version: result.version }, 201);
    } catch (error) {
      return jsonError(
        "unidentified_package_failed",
        errorMessage(error),
        (error as { code?: string }).code === "storage-unavailable" ? 503 : 400,
      );
    }
  });

  app.post("/unidentified/:unidentifiedPackageId/reconcile", async (c) => {
    const access = requireIntakeAccess(c, "return-intake.manage");
    if (access.response) return access.response;
    const context = requireContext(c);
    if (!context) return jsonError("authentication_required", "Authenticated command context is required.", 401);
    const body = (await c.req.json()) as Record<string, unknown>;
    const unidentifiedPackageId = c.req.param("unidentifiedPackageId");
    const unidentified = await services.getUnidentifiedPackage(unidentifiedPackageId);
    if (!unidentified) return jsonError("not_found", "Unidentified package was not found.", 404);
    const target = await services.resolveForIntake(String(body.returnShipmentId ?? ""), unidentified.facility_id);
    if (target.outcome !== "resolved") {
      return jsonError("reconciliation_conflict", "Return shipment is not expected at this facility.", 409);
    }
    try {
      const result = await services.unidentifiedPackageCommandHandler({
        streamId: unidentifiedReturnPackageStreamId(unidentifiedPackageId),
        context,
        command: {
          type: "ReconcileUnidentifiedReturnPackage",
          returnShipmentId: target.shipment.return_shipment_id as never,
          reconciledByUserId: access.actor.userId,
          reconciledAt: new Date().toISOString(),
          reason: String(body.reason ?? ""),
        },
      });
      return c.json({
        unidentifiedPackageId,
        returnShipmentId: target.shipment.return_shipment_id,
        version: result.version,
      });
    } catch (error) {
      return jsonError("reconciliation_conflict", errorMessage(error), 409);
    }
  });

  return app;
}
