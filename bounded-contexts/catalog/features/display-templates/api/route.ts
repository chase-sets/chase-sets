import { coerceLocalizedTextMap, t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { DisplayTemplateId } from "../../../ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { CatalogDomainError } from "../../../support/runtime-support/common";
import type { DisplayTemplateTarget } from "../domain/domain";
import type { DisplayTemplateServices } from "./runtime";

export function displayTemplateRoutes(services: DisplayTemplateServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/", async (c) => {
    const body = await c.req.json();
    const displayTemplateId = body.displayTemplateId as DisplayTemplateId;
    const result = await services.commandHandler({
      streamId: `catalog.display-template-${displayTemplateId}`,
      command: {
        type: "CreateDisplayTemplate",
        displayTemplateId,
        key: String(body.key ?? ""),
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        target: toDisplayTemplateTarget(body.target),
        priority: Number(body.priority ?? 0),
        titleTemplate: String(body.titleTemplate ?? ""),
        subtitleTemplate: typeof body.subtitleTemplate === "string" ? body.subtitleTemplate : null,
        requiredFieldKeys: toStringArray(body.requiredFieldKeys),
      },
      context: c.get("context"),
    });

    return c.json({ id: displayTemplateId, version: result.version, status: result.state.status }, 201);
  });

  app.put("/:id", async (c) => {
    const displayTemplateId = c.req.param("id");
    const body = await c.req.json();
    const result = await services.commandHandler({
      streamId: `catalog.display-template-${displayTemplateId}`,
      command: {
        type: "ReviseDisplayTemplate",
        key: String(body.key ?? ""),
        name: coerceLocalizedTextMap(body.name),
        description: coerceLocalizedTextMap(body.description ?? ""),
        target: toDisplayTemplateTarget(body.target),
        priority: Number(body.priority ?? 0),
        titleTemplate: String(body.titleTemplate ?? ""),
        subtitleTemplate: typeof body.subtitleTemplate === "string" ? body.subtitleTemplate : null,
        requiredFieldKeys: toStringArray(body.requiredFieldKeys),
      },
      context: c.get("context"),
    });

    return c.json({ id: displayTemplateId, version: result.version, status: result.state.status });
  });

  app.post("/:id/publish", async (c) => {
    const displayTemplateId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `catalog.display-template-${displayTemplateId}`,
      command: { type: "PublishDisplayTemplate" },
      context: c.get("context"),
    });

    return c.json({ id: displayTemplateId, version: result.version, status: result.state.status });
  });

  app.post("/:id/deprecate", async (c) => {
    const displayTemplateId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `catalog.display-template-${displayTemplateId}`,
      command: { type: "DeprecateDisplayTemplate" },
      context: c.get("context"),
    });

    return c.json({ id: displayTemplateId, version: result.version, status: result.state.status });
  });

  app.post("/:id/archive", async (c) => {
    const displayTemplateId = c.req.param("id");
    const result = await services.commandHandler({
      streamId: `catalog.display-template-${displayTemplateId}`,
      command: { type: "ArchiveDisplayTemplate" },
      context: c.get("context"),
    });

    return c.json({ id: displayTemplateId, version: result.version, status: result.state.status });
  });

  app.get("/", async (c) => {
    const { search, status, targetKind, limit, offset } = c.req.query();
    const result = await services.listDisplayTemplates({
      search,
      status,
      targetKind,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
    });

    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/:id", async (c) => {
    const template = await services.getDisplayTemplateDetail(c.req.param("id"));

    if (!template) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.displayTemplates.api.route.display.template.not.found"),
          },
        },
        404,
      );
    }

    return c.json(template);
  });

  return app;
}

function toDisplayTemplateTarget(value: unknown): DisplayTemplateTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogDomainError("Display Template target is required.");
  }

  const target = value as { kind?: unknown; id?: unknown };
  return {
    kind: String(target.kind ?? "global") as DisplayTemplateTarget["kind"],
    id: typeof target.id === "string" ? target.id : undefined,
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
