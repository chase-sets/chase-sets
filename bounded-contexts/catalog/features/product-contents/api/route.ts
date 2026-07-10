import { Hono } from "hono";
import { parseOptionalTypedIdBoundary, parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type {
  ProductContentLineInput,
  ProductContentProvenance,
  ProductContentSelectedOption,
  ProductContentServices,
  ReplaceProductContentsInput,
} from "./runtime";

export function productContentRoutes(services: ProductContentServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/content-types", async (c) => {
    const items = await services.listProductContentTypes();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/inclusion-policies", async (c) => {
    const items = await services.listProductContentInclusionPolicies();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/containers/:id", async (c) => {
    const items = await services.listProductContentsForContainer(c.req.param("id"));
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/contained/:id", async (c) => {
    const items = await services.listProductContainersForContained(c.req.param("id"));
    return c.json({ items, total: items.length, count: items.length });
  });

  app.put("/containers/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.replaceProductContents(
      toReplaceProductContentsInput(c.req.param("id"), body),
      c.get("context"),
    );
    return c.json(result);
  });

  app.delete("/containers/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.removeProductContents(
      {
        containerCatalogItemId: parseTypedIdBoundary(c.req.param("id"), "cat", "containerCatalogItemId"),
        containerSelectedOptions: toSelectedOptions(
          (body as { containerSelectedOptions?: unknown }).containerSelectedOptions,
        ),
      },
      c.get("context"),
    );
    return c.json(result);
  });

  return app;
}

function toReplaceProductContentsInput(containerCatalogItemId: string, value: unknown): ReplaceProductContentsInput {
  const body = isRecord(value) ? value : {};

  return {
    containerCatalogItemId: parseTypedIdBoundary(containerCatalogItemId, "cat", "containerCatalogItemId"),
    containerSelectedOptions: toSelectedOptions(body.containerSelectedOptions),
    lines: Array.isArray(body.lines) ? body.lines.map(toLineInput) : [],
  };
}

function toLineInput(value: unknown): ProductContentLineInput {
  const line = isRecord(value) ? value : {};

  return {
    containedCatalogItemId:
      parseOptionalTypedIdBoundary(line.containedCatalogItemId, "cat", "containedCatalogItemId") ?? null,
    containedSelectedOptions: toSelectedOptions(line.containedSelectedOptions),
    quantity: line.quantity === null ? null : Number(line.quantity ?? 1),
    contentTypeId: String(line.contentTypeId ?? ""),
    inclusionPolicyId: typeof line.inclusionPolicyId === "string" ? line.inclusionPolicyId : null,
    provenance: toProvenance(line.provenance),
  };
}

function toProvenance(value: unknown): ProductContentProvenance {
  if (!isRecord(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as ProductContentProvenance;
}

function toSelectedOptions(value: unknown): readonly ProductContentSelectedOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      return {
        dimensionId: String(entry.dimensionId ?? ""),
        optionId: String(entry.optionId ?? ""),
      };
    })
    .filter((entry): entry is ProductContentSelectedOption => entry !== null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
