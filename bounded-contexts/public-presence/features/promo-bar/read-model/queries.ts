import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PromoBarMessage, PromoBarMessageTone, SavePromoBarMessageRequest } from "../api/contracts";

const tones = new Set<PromoBarMessageTone>(["info", "success", "warning"]);

function optionalText(value: string | null | undefined, maxLength: number) {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text.slice(0, maxLength) : null;
}

function normalizeTimestamp(value: string | null | undefined) {
  const text = value?.trim() ?? "";
  if (!text) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Promo bar dates must be valid dates.");
  }

  return date.toISOString();
}

function normalizeHref(value: string | null | undefined) {
  const href = optionalText(value, 240);
  if (!href) {
    return null;
  }

  if (href.startsWith("/") || href.startsWith("https://")) {
    return href;
  }

  throw new Error("Promo bar links must be internal paths or HTTPS URLs.");
}

function normalizeInput(input: SavePromoBarMessageRequest) {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new Error("Promo bar title is required.");
  }

  const startsAt = normalizeTimestamp(input.startsAt);
  const endsAt = normalizeTimestamp(input.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw new Error("Promo bar end date must be after the start date.");
  }

  const tone = input.tone && tones.has(input.tone) ? input.tone : "info";

  return {
    title: title.slice(0, 140),
    description: optionalText(input.description, 260),
    href: normalizeHref(input.href),
    linkLabel: optionalText(input.linkLabel, 80),
    tone,
    isActive: input.isActive ?? true,
    displayOrder: Number.isFinite(input.displayOrder) ? Math.trunc(input.displayOrder ?? 100) : 100,
    startsAt,
    endsAt,
  };
}

function mapRow(row: PromoBarMessage): PromoBarMessage {
  return {
    ...row,
    display_order: Number(row.display_order),
    is_active: Boolean(row.is_active),
  };
}

export async function listActivePromoBarMessages(db: PgQueryable, now = new Date()): Promise<PromoBarMessage[]> {
  const result = await db.query<PromoBarMessage>(
    `SELECT
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at::text AS starts_at,
       ends_at::text AS ends_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM public_presence_promo_bar_messages
     WHERE is_active = true
       AND (starts_at IS NULL OR starts_at <= $1)
       AND (ends_at IS NULL OR ends_at > $1)
     ORDER BY display_order ASC, updated_at DESC, id ASC`,
    [now.toISOString()],
  );

  return result.rows.map(mapRow);
}

export async function listPromoBarMessages(db: PgQueryable): Promise<PromoBarMessage[]> {
  const result = await db.query<PromoBarMessage>(
    `SELECT
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at::text AS starts_at,
       ends_at::text AS ends_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at
     FROM public_presence_promo_bar_messages
     ORDER BY display_order ASC, updated_at DESC, id ASC`,
  );

  return result.rows.map(mapRow);
}

export async function createPromoBarMessage(
  db: PgQueryable,
  input: SavePromoBarMessageRequest,
): Promise<PromoBarMessage> {
  const message = normalizeInput(input);
  const now = new Date().toISOString();
  const id = `pbm_${crypto.randomUUID().replace(/-/g, "")}`;
  const result = await db.query<PromoBarMessage>(
    `INSERT INTO public_presence_promo_bar_messages (
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at,
       ends_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $11::timestamptz)
     RETURNING
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at::text AS starts_at,
       ends_at::text AS ends_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at`,
    [
      id,
      message.title,
      message.description,
      message.href,
      message.linkLabel,
      message.tone,
      message.isActive,
      message.displayOrder,
      message.startsAt,
      message.endsAt,
      now,
    ],
  );

  return mapRow(result.rows[0]!);
}

export async function updatePromoBarMessage(
  db: PgQueryable,
  id: string,
  input: SavePromoBarMessageRequest,
): Promise<PromoBarMessage | null> {
  const message = normalizeInput(input);
  const now = new Date().toISOString();
  const result = await db.query<PromoBarMessage>(
    `UPDATE public_presence_promo_bar_messages
     SET title = $2,
         description = $3,
         href = $4,
         link_label = $5,
         tone = $6,
         is_active = $7,
         display_order = $8,
         starts_at = $9::timestamptz,
         ends_at = $10::timestamptz,
         updated_at = $11::timestamptz
     WHERE id = $1
     RETURNING
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at::text AS starts_at,
       ends_at::text AS ends_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at`,
    [
      id,
      message.title,
      message.description,
      message.href,
      message.linkLabel,
      message.tone,
      message.isActive,
      message.displayOrder,
      message.startsAt,
      message.endsAt,
      now,
    ],
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function setPromoBarMessageActive(
  db: PgQueryable,
  id: string,
  isActive: boolean,
): Promise<PromoBarMessage | null> {
  const result = await db.query<PromoBarMessage>(
    `UPDATE public_presence_promo_bar_messages
     SET is_active = $2,
         updated_at = $3::timestamptz
     WHERE id = $1
     RETURNING
       id,
       title,
       description,
       href,
       link_label,
       tone,
       is_active,
       display_order,
       starts_at::text AS starts_at,
       ends_at::text AS ends_at,
       created_at::text AS created_at,
       updated_at::text AS updated_at`,
    [id, isActive, new Date().toISOString()],
  );

  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function deletePromoBarMessage(db: PgQueryable, id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM public_presence_promo_bar_messages WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
