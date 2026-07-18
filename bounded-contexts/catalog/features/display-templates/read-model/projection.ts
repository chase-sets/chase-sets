import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { resolveLocalizedTextMap, type LocalizedTextMap } from "../../../support/runtime-support/common";

const STREAM_PREFIX = "catalog.display-template-";

export function buildDisplayTemplateProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.display-template.created": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const {
        displayTemplateId,
        key,
        name,
        description,
        target,
        priority,
        titleTemplate,
        subtitleTemplate,
        requiredFieldKeys,
      } = event.data as DisplayTemplateEventData & { displayTemplateId: string };

      await upsertDisplayTemplate(projectionDb, {
        displayTemplateId,
        key,
        name,
        description,
        target,
        priority,
        titleTemplate,
        subtitleTemplate,
        requiredFieldKeys,
        status: "draft",
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.display-template.revised": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const displayTemplateId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, target, priority, titleTemplate, subtitleTemplate, requiredFieldKeys } =
        event.data as DisplayTemplateEventData;

      await upsertDisplayTemplate(projectionDb, {
        displayTemplateId,
        key,
        name,
        description,
        target,
        priority,
        titleTemplate,
        subtitleTemplate,
        requiredFieldKeys,
        status: null,
        updatedAt: event.timing.recordedAt,
      });
    },
    "catalog.display-template.published": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      await updateDisplayTemplateStatus(
        projectionDb,
        extractIdFromStreamId(event.streamId, STREAM_PREFIX),
        "active",
        event.timing.recordedAt,
      );
    },
    "catalog.display-template.deprecated": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      await updateDisplayTemplateStatus(
        projectionDb,
        extractIdFromStreamId(event.streamId, STREAM_PREFIX),
        "deprecated",
        event.timing.recordedAt,
      );
    },
    "catalog.display-template.archived": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      await updateDisplayTemplateStatus(
        projectionDb,
        extractIdFromStreamId(event.streamId, STREAM_PREFIX),
        "archived",
        event.timing.recordedAt,
      );
    },
  };
}

type DisplayTemplateEventData = Readonly<{
  key: string;
  name: LocalizedTextMap;
  description: LocalizedTextMap;
  target: { kind: string; id?: string };
  priority: number;
  titleTemplate: string;
  subtitleTemplate: string | null;
  requiredFieldKeys?: readonly string[];
}>;

async function upsertDisplayTemplate(
  db: PgQueryable,
  input: Readonly<{
    displayTemplateId: string;
    key: string;
    name: LocalizedTextMap;
    description: LocalizedTextMap;
    target: { kind: string; id?: string };
    priority: number;
    titleTemplate: string;
    subtitleTemplate: string | null;
    requiredFieldKeys?: readonly string[];
    status: string | null;
    updatedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_display_templates (
       display_template_id,
       key,
       name_i18n,
       name,
       description_i18n,
       description,
       target_kind,
       target_id,
       priority,
       title_template,
       subtitle_template,
       required_field_keys,
       status,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, 'draft'), $14)
     ON CONFLICT (display_template_id) DO UPDATE SET
       key = EXCLUDED.key,
       name_i18n = EXCLUDED.name_i18n,
       name = EXCLUDED.name,
       description_i18n = EXCLUDED.description_i18n,
       description = EXCLUDED.description,
       target_kind = EXCLUDED.target_kind,
       target_id = EXCLUDED.target_id,
       priority = EXCLUDED.priority,
       title_template = EXCLUDED.title_template,
       subtitle_template = EXCLUDED.subtitle_template,
       required_field_keys = EXCLUDED.required_field_keys,
       status = COALESCE($13::text, catalog_display_templates.status),
       updated_at = EXCLUDED.updated_at`,
    [
      input.displayTemplateId,
      input.key,
      JSON.stringify(input.name),
      resolveLocalizedTextMap(input.name),
      JSON.stringify(input.description),
      resolveLocalizedTextMap(input.description),
      input.target.kind,
      input.target.kind === "global" ? null : (input.target.id ?? null),
      input.priority,
      input.titleTemplate,
      input.subtitleTemplate,
      JSON.stringify(input.requiredFieldKeys ?? []),
      input.status,
      input.updatedAt,
    ],
  );
}

async function updateDisplayTemplateStatus(
  db: PgQueryable,
  displayTemplateId: string,
  status: string,
  updatedAt: string,
): Promise<void> {
  await db.query(`UPDATE catalog_display_templates SET status = $2, updated_at = $3 WHERE display_template_id = $1`, [
    displayTemplateId,
    status,
    updatedAt,
  ]);
}
