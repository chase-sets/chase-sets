import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { ReferenceDataServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function referenceDataRoutes(
  services: ReferenceDataServices,
  authoringBulkJobs: CatalogAuthoringBulkJobServices,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/reference-types", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const referenceTypeId = parseTypedIdBoundary(body.referenceTypeId, "rft", "referenceTypeId");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: {
        type: "CreateReferenceType",
        referenceTypeId,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        attributeKeys: Array.isArray(body.attributeKeys) ? body.attributeKeys : [],
      },
      context,
    });

    return c.json(commandSnapshotResponse(referenceTypeId, result), 201);
  });

  app.post("/reference-types/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.referenceTypeBulkLifecycle.preview(
      normalizeBulkSelection(body.selection, referenceTypeListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/reference-types/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.reference-types.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, referenceTypeListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/reference-types/:id", async (c) => {
    const referenceTypeId = parseTypedIdBoundary(c.req.param("id"), "rft", "referenceTypeId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: {
        type: "ReviseReferenceType",
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        attributeKeys: Array.isArray(body.attributeKeys) ? body.attributeKeys : [],
      },
      context,
    });

    return c.json(commandSnapshotResponse(referenceTypeId, result));
  });

  app.post("/reference-types/:id/publish", async (c) => {
    const referenceTypeId = parseTypedIdBoundary(c.req.param("id"), "rft", "referenceTypeId");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "PublishReferenceType" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceTypeId, result));
  });

  app.post("/reference-types/:id/deprecate", async (c) => {
    const referenceTypeId = parseTypedIdBoundary(c.req.param("id"), "rft", "referenceTypeId");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "DeprecateReferenceType" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceTypeId, result));
  });

  app.post("/reference-types/:id/archive", async (c) => {
    const referenceTypeId = parseTypedIdBoundary(c.req.param("id"), "rft", "referenceTypeId");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "ArchiveReferenceType" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceTypeId, result));
  });

  app.get("/reference-types", async (c) => {
    const { search, status, limit, offset, attributeKey } = c.req.query();
    const result = await services.listReferenceTypes({
      search,
      status,
      attributeKey,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/reference-types/:id", async (c) => {
    const referenceType = await services.getReferenceType(c.req.param("id"));

    if (!referenceType) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.referenceData.api.route.reference.type.not.found"),
          },
        },
        404,
      );
    }

    return c.json(referenceType);
  });

  app.post("/reference-records", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const referenceRecordId = parseTypedIdBoundary(body.referenceRecordId, "ref", "referenceRecordId");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: {
        type: "CreateReferenceRecord",
        referenceRecordId,
        typeKey: body.typeKey,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        attributes: isRecord(body.attributes) ? body.attributes : {},
        relationships: Array.isArray(body.relationships) ? body.relationships : [],
      },
      context,
    });

    return c.json(commandSnapshotResponse(referenceRecordId, result), 201);
  });

  app.post("/reference-records/bulk-lifecycle/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.referenceRecordBulkLifecycle.preview(
      normalizeBulkSelection(body.selection, referenceRecordListQueryFromRecord),
      String(body.action ?? ""),
    );

    return c.json(result);
  });

  app.post("/reference-records/bulk-lifecycle/confirm", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const result = await authoringBulkJobs.enqueue({
      kind: "catalog.authoring.reference-records.lifecycle",
      action,
      selection: normalizeBulkSelection(body.selection, referenceRecordListQueryFromRecord),
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.put("/reference-records/:id", async (c) => {
    const referenceRecordId = parseTypedIdBoundary(c.req.param("id"), "ref", "referenceRecordId");
    const body = await c.req.json();
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: {
        type: "ReviseReferenceRecord",
        typeKey: body.typeKey,
        key: body.key,
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        attributes: isRecord(body.attributes) ? body.attributes : {},
        relationships: Array.isArray(body.relationships) ? body.relationships : [],
      },
      context,
    });

    return c.json(commandSnapshotResponse(referenceRecordId, result));
  });

  app.post("/reference-records/:id/publish", async (c) => {
    const referenceRecordId = parseTypedIdBoundary(c.req.param("id"), "ref", "referenceRecordId");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "PublishReferenceRecord" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceRecordId, result));
  });

  app.post("/reference-records/:id/deprecate", async (c) => {
    const referenceRecordId = parseTypedIdBoundary(c.req.param("id"), "ref", "referenceRecordId");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "DeprecateReferenceRecord" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceRecordId, result));
  });

  app.post("/reference-records/:id/archive", async (c) => {
    const referenceRecordId = parseTypedIdBoundary(c.req.param("id"), "ref", "referenceRecordId");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "ArchiveReferenceRecord" },
      context,
    });

    return c.json(commandSnapshotResponse(referenceRecordId, result));
  });

  app.get("/reference-records", async (c) => {
    const {
      search,
      status,
      limit,
      offset,
      typeKey,
      relationshipType,
      relatedReferenceId,
      attributeKey,
      attributeValue,
    } = c.req.query();
    const result = await services.listReferenceRecords({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      typeKey,
      relationshipType,
      relatedReferenceId,
      attributeKey,
      attributeValue,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/reference-records/:id", async (c) => {
    const referenceRecord = await services.getReferenceRecord(c.req.param("id"));

    if (!referenceRecord) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.referenceData.api.route.reference.record.not.found"),
          },
        },
        404,
      );
    }

    return c.json(referenceRecord);
  });

  return app;
}

function referenceTypeListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    attributeKey: toOptionalString(record.attributeKey),
  };
}

function referenceRecordListQueryFromRecord(record: Record<string, unknown>) {
  return {
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    typeKey: toOptionalString(record.typeKey),
    relationshipType: toOptionalString(record.relationshipType),
    relatedReferenceId: toOptionalString(record.relatedReferenceId),
    attributeKey: toOptionalString(record.attributeKey),
    attributeValue: toOptionalString(record.attributeValue),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
