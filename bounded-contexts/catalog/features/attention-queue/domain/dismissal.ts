import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { JsonObject } from "@chase-sets/primitives/json";
import { assert, assertNever } from "../../../support/runtime-support/common";
import type { CatalogAttentionItemKind } from "../read-model/attention-item";

// ---------------------------------------------------------------------------
// Catalog attention-item dismissal aggregate
//
// An operator can park an attention-queue item they intentionally leave for
// later: `dismiss` hides it until explicitly restored, `defer` hides it until a
// re-surface time after which it ages back into the queue. The aggregate is
// keyed by the item's stable `itemKey`, so parking the same item twice is
// idempotent and the full park/restore history is retained for audit.
//
//   (active) ──dismiss──▶ dismissed ──restore──▶ active
//       └────defer(until t)──▶ deferred ──(t elapses ⇒ ages back)──▶ active
//                                 └──restore──▶ active
// ---------------------------------------------------------------------------

export const CATALOG_ATTENTION_DISMISSAL_STREAM_PREFIX = "catalog.attention-dismissal-";

export function catalogAttentionDismissalStreamId(itemKey: string): string {
  return `${CATALOG_ATTENTION_DISMISSAL_STREAM_PREFIX}${itemKey}`;
}

export type CatalogAttentionDisposition = "active" | "dismissed" | "deferred";

export type CatalogAttentionDismissalState = Readonly<{
  itemKey: string | null;
  kind: CatalogAttentionItemKind | null;
  disposition: CatalogAttentionDisposition;
  reason: string | null;
  deferredUntil: string | null;
  lastActor: string | null;
}>;

export const initialCatalogAttentionDismissalState: CatalogAttentionDismissalState = {
  itemKey: null,
  kind: null,
  disposition: "active",
  reason: null,
  deferredUntil: null,
  lastActor: null,
};

export type DismissAttentionItemCommand = Readonly<{
  type: "DismissAttentionItem";
  itemKey: string;
  kind: CatalogAttentionItemKind;
  actor: string;
  reason: string;
}>;

export type DeferAttentionItemCommand = Readonly<{
  type: "DeferAttentionItem";
  itemKey: string;
  kind: CatalogAttentionItemKind;
  actor: string;
  reason: string;
  deferredUntil: string;
}>;

export type RestoreAttentionItemCommand = Readonly<{
  type: "RestoreAttentionItem";
  itemKey: string;
  actor: string;
}>;

export type CatalogAttentionDismissalCommand =
  | DismissAttentionItemCommand
  | DeferAttentionItemCommand
  | RestoreAttentionItemCommand;

type AttentionParkedData = JsonObject &
  Readonly<{ itemKey: string; kind: CatalogAttentionItemKind; actor: string; reason: string }>;
type AttentionDeferredData = AttentionParkedData & Readonly<{ deferredUntil: string }>;
type AttentionRestoredData = JsonObject & Readonly<{ itemKey: string; actor: string }>;

export type CatalogAttentionItemDismissedEvent = DomainEvent<"catalog.attention-item.dismissed", AttentionParkedData>;
export type CatalogAttentionItemDeferredEvent = DomainEvent<"catalog.attention-item.deferred", AttentionDeferredData>;
export type CatalogAttentionItemRestoredEvent = DomainEvent<"catalog.attention-item.restored", AttentionRestoredData>;

export type CatalogAttentionDismissalEvent =
  | CatalogAttentionItemDismissedEvent
  | CatalogAttentionItemDeferredEvent
  | CatalogAttentionItemRestoredEvent;

export const decideCatalogAttentionDismissal: AggregateDecider<
  CatalogAttentionDismissalState,
  CatalogAttentionDismissalCommand,
  CatalogAttentionDismissalEvent
> = (state, command) => {
  switch (command.type) {
    case "DismissAttentionItem": {
      assert(command.itemKey.trim().length > 0, "Dismissing an attention item requires an item key.");
      assert(command.actor.trim().length > 0, "Dismissing an attention item requires an actor.");
      assert(command.reason.trim().length > 0, "Dismissing an attention item requires a reason.");
      if (state.disposition === "dismissed" && state.reason === command.reason.trim()) {
        return [];
      }
      return [
        {
          type: "catalog.attention-item.dismissed",
          data: {
            itemKey: command.itemKey.trim(),
            kind: command.kind,
            actor: command.actor.trim(),
            reason: command.reason.trim(),
          },
        },
      ];
    }
    case "DeferAttentionItem": {
      assert(command.itemKey.trim().length > 0, "Deferring an attention item requires an item key.");
      assert(command.actor.trim().length > 0, "Deferring an attention item requires an actor.");
      assert(command.reason.trim().length > 0, "Deferring an attention item requires a reason.");
      assert(isIsoTimestamp(command.deferredUntil), "Deferring an attention item requires a valid re-surface time.");
      if (state.disposition === "deferred" && state.deferredUntil === command.deferredUntil) {
        return [];
      }
      return [
        {
          type: "catalog.attention-item.deferred",
          data: {
            itemKey: command.itemKey.trim(),
            kind: command.kind,
            actor: command.actor.trim(),
            reason: command.reason.trim(),
            deferredUntil: command.deferredUntil,
          },
        },
      ];
    }
    case "RestoreAttentionItem": {
      assert(command.itemKey.trim().length > 0, "Restoring an attention item requires an item key.");
      assert(command.actor.trim().length > 0, "Restoring an attention item requires an actor.");
      // Idempotent: an active item stays active.
      if (state.disposition === "active") {
        return [];
      }
      return [
        {
          type: "catalog.attention-item.restored",
          data: { itemKey: command.itemKey.trim(), actor: command.actor.trim() },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveCatalogAttentionDismissal: AggregateEvolver<
  CatalogAttentionDismissalState,
  CatalogAttentionDismissalEvent
> = (state, event) => {
  switch (event.type) {
    case "catalog.attention-item.dismissed":
      return {
        ...state,
        itemKey: event.data.itemKey,
        kind: event.data.kind,
        disposition: "dismissed",
        reason: event.data.reason,
        deferredUntil: null,
        lastActor: event.data.actor,
      };
    case "catalog.attention-item.deferred":
      return {
        ...state,
        itemKey: event.data.itemKey,
        kind: event.data.kind,
        disposition: "deferred",
        reason: event.data.reason,
        deferredUntil: event.data.deferredUntil,
        lastActor: event.data.actor,
      };
    case "catalog.attention-item.restored":
      return {
        ...state,
        itemKey: event.data.itemKey,
        disposition: "active",
        reason: null,
        deferredUntil: null,
        lastActor: event.data.actor,
      };
    default:
      return assertNever(event);
  }
};

function isIsoTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
