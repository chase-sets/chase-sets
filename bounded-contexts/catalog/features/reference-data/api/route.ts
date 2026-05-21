import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { ReferenceDataServices } from "./runtime";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";

export function referenceDataRoutes(services: ReferenceDataServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/reference-types", async (c) => {
    const body = await c.req.json();
    const context = c.get("context");
    const referenceTypeId = body.referenceTypeId as ReferenceTypeId;

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

    return c.json({ id: referenceTypeId, version: result.version, status: result.state.status }, 201);
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
    const result = await services.referenceTypeBulkLifecycle.execute(
      normalizeBulkSelection(body.selection, referenceTypeListQueryFromRecord),
      String(body.action ?? ""),
      c.get("context"),
    );

    return c.json(result);
  });

  app.put("/reference-types/:id", async (c) => {
    const referenceTypeId = c.req.param("id");
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

    return c.json({ id: referenceTypeId, version: result.version, status: result.state.status });
  });

  app.post("/reference-types/:id/publish", async (c) => {
    const referenceTypeId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "PublishReferenceType" },
      context,
    });

    return c.json({ id: referenceTypeId, version: result.version, status: result.state.status });
  });

  app.post("/reference-types/:id/deprecate", async (c) => {
    const referenceTypeId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "DeprecateReferenceType" },
      context,
    });

    return c.json({ id: referenceTypeId, version: result.version, status: result.state.status });
  });

  app.post("/reference-types/:id/archive", async (c) => {
    const referenceTypeId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceTypeCommandHandler({
      streamId: `catalog.reference-type-${referenceTypeId}`,
      command: { type: "ArchiveReferenceType" },
      context,
    });

    return c.json({ id: referenceTypeId, version: result.version, status: result.state.status });
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
    const referenceRecordId = body.referenceRecordId as ReferenceRecordId;

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

    return c.json({ id: referenceRecordId, version: result.version, status: result.state.status }, 201);
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
    const result = await services.referenceRecordBulkLifecycle.execute(
      normalizeBulkSelection(body.selection, referenceRecordListQueryFromRecord),
      String(body.action ?? ""),
      c.get("context"),
    );

    return c.json(result);
  });

  app.put("/reference-records/:id", async (c) => {
    const referenceRecordId = c.req.param("id");
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

    return c.json({ id: referenceRecordId, version: result.version, status: result.state.status });
  });

  app.post("/reference-records/:id/publish", async (c) => {
    const referenceRecordId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "PublishReferenceRecord" },
      context,
    });

    return c.json({ id: referenceRecordId, version: result.version, status: result.state.status });
  });

  app.post("/reference-records/:id/deprecate", async (c) => {
    const referenceRecordId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "DeprecateReferenceRecord" },
      context,
    });

    return c.json({ id: referenceRecordId, version: result.version, status: result.state.status });
  });

  app.post("/reference-records/:id/archive", async (c) => {
    const referenceRecordId = c.req.param("id");
    const context = c.get("context");

    const result = await services.referenceRecordCommandHandler({
      streamId: `catalog.reference-record-${referenceRecordId}`,
      command: { type: "ArchiveReferenceRecord" },
      context,
    });

    return c.json({ id: referenceRecordId, version: result.version, status: result.state.status });
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
