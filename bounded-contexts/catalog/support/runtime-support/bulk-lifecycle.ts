import type { DomainEvent } from "@chase-sets/event-core/domain";
import type {
  CommandHandler,
  CommandHandlerInput,
} from "@chase-sets/event-core/command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";
import { CatalogDomainError } from "./common";

export type BulkSelection<Query> =
  | Readonly<{ mode: "ids"; ids: readonly string[] }>
  | Readonly<{ mode: "filter"; query: Query }>;

export type BulkLifecycleCandidateOutcome =
  | "ready"
  | "blocked"
  | "succeeded"
  | "skipped"
  | "failed";

export type BulkLifecycleCandidate = Readonly<{
  id: string;
  label: string;
  status: string;
  outcome: BulkLifecycleCandidateOutcome;
  reason: string | null;
}>;

export type BulkLifecyclePreview = Readonly<{
  mode: BulkSelection<unknown>["mode"];
  action: string;
  ids: readonly string[];
  total: number;
  ready_count: number;
  blocked_count: number;
  candidates: readonly BulkLifecycleCandidate[];
}>;

export type BulkLifecycleResult = Readonly<{
  action: string;
  ids: readonly string[];
  total: number;
  succeeded_count: number;
  skipped_count: number;
  failed_count: number;
  candidates: readonly BulkLifecycleCandidate[];
}>;

export type BulkLifecycleActionDefinition<Command> = Readonly<{
  action: string;
  readyStatus: string;
  command: Command;
  streamId: (id: string) => string;
  blockedReason: (status: string) => string;
}>;

export type BulkLifecycleRow = Readonly<{
  id: string;
  label: string;
  status: string;
}>;

export type BulkLifecycleOperations<Query, Command, State, Event extends DomainEvent> = Readonly<{
  preview: (
    selection: BulkSelection<Query>,
    action: string,
  ) => Promise<BulkLifecyclePreview>;
  execute: (
    selection: BulkSelection<Query>,
    action: string,
    context: EventStoreContext,
  ) => Promise<BulkLifecycleResult>;
}>;

export function createBulkLifecycleOperations<Query, Command, State, Event extends DomainEvent>(
  config: Readonly<{
    actions: readonly BulkLifecycleActionDefinition<Command>[];
    commandHandler: CommandHandler<Command, State, Event>;
    resolveIds: (selection: BulkSelection<Query>) => Promise<readonly string[]>;
    loadRows: (ids: readonly string[]) => Promise<readonly BulkLifecycleRow[]>;
    projectors?: readonly Projector[];
  }>,
): BulkLifecycleOperations<Query, Command, State, Event> {
  async function preview(
    selection: BulkSelection<Query>,
    action: string,
  ): Promise<BulkLifecyclePreview> {
    const definition = resolveAction(config.actions, action);
    const ids = normalizeBulkIds(await config.resolveIds(selection));
    const candidates = await classifyCandidates(config.loadRows, ids, definition);
    const readyCount = candidates.filter((candidate) => candidate.outcome === "ready").length;

    return {
      mode: selection.mode,
      action,
      ids,
      total: candidates.length,
      ready_count: readyCount,
      blocked_count: candidates.length - readyCount,
      candidates,
    };
  }

  async function execute(
    selection: BulkSelection<Query>,
    action: string,
    context: EventStoreContext,
  ): Promise<BulkLifecycleResult> {
    const definition = resolveAction(config.actions, action);
    const ids = normalizeBulkIds(await config.resolveIds(selection));
    const previewCandidates = await classifyCandidates(config.loadRows, ids, definition);
    const candidates: BulkLifecycleCandidate[] = [];

    for (const candidate of previewCandidates) {
      if (candidate.outcome !== "ready") {
        candidates.push({ ...candidate, outcome: "skipped" });
        continue;
      }

      try {
        const input: CommandHandlerInput<Command> = {
          streamId: definition.streamId(candidate.id),
          command: definition.command,
          context,
        };
        const result = await config.commandHandler(input);
        const nextStatus = stateStatus(result.state) ?? candidate.status;

        candidates.push({
          ...candidate,
          status: nextStatus,
          outcome: "succeeded",
          reason: null,
        });
      } catch (error) {
        candidates.push({
          ...candidate,
          outcome: "failed",
          reason: error instanceof Error ? error.message : "Bulk action failed.",
        });
      }
    }

    if (config.projectors) {
      await drainRuntimeProjectors(config.projectors);
    }

    return {
      action,
      ids,
      total: candidates.length,
      succeeded_count: candidates.filter((candidate) => candidate.outcome === "succeeded").length,
      skipped_count: candidates.filter((candidate) => candidate.outcome === "skipped").length,
      failed_count: candidates.filter((candidate) => candidate.outcome === "failed").length,
      candidates,
    };
  }

  return { preview, execute };
}

export function normalizeBulkSelection<Query>(
  value: unknown,
  normalizeQuery: (query: Record<string, unknown>) => Query,
): BulkSelection<Query> {
  if (!value || typeof value !== "object") {
    return { mode: "ids", ids: [] };
  }

  const selection = value as { mode?: unknown; ids?: unknown; query?: unknown };
  if (selection.mode === "filter") {
    const query = selection.query && typeof selection.query === "object" && !Array.isArray(selection.query)
      ? selection.query as Record<string, unknown>
      : {};

    return { mode: "filter", query: normalizeQuery(query) };
  }

  return { mode: "ids", ids: toStringArray(selection.ids) };
}

export function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

async function classifyCandidates<Command>(
  loadRows: (ids: readonly string[]) => Promise<readonly BulkLifecycleRow[]>,
  ids: readonly string[],
  action: BulkLifecycleActionDefinition<Command>,
): Promise<BulkLifecycleCandidate[]> {
  const rows = await loadRows(ids);
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return ids.map((id) => {
    const row = rowsById.get(id);

    if (!row) {
      return {
        id,
        label: id,
        status: "missing",
        outcome: "blocked",
        reason: "Record was not found.",
      };
    }

    if (row.status !== action.readyStatus) {
      return {
        ...row,
        outcome: "blocked",
        reason: action.blockedReason(row.status),
      };
    }

    return {
      ...row,
      outcome: "ready",
      reason: null,
    };
  });
}

function normalizeBulkIds(ids: readonly string[]): string[] {
  const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));

  if (normalized.length === 0) {
    throw new CatalogDomainError("Choose at least one record.");
  }

  return normalized;
}

function resolveAction<Command>(
  actions: readonly BulkLifecycleActionDefinition<Command>[],
  action: string,
) {
  const definition = actions.find((candidate) => candidate.action === action);

  if (!definition) {
    throw new CatalogDomainError(`Unknown bulk action: ${action}.`);
  }

  return definition;
}

function stateStatus(state: unknown): string | null {
  if (state && typeof state === "object" && "status" in state) {
    const status = (state as { status?: unknown }).status;
    return typeof status === "string" ? status : null;
  }

  return null;
}

async function drainRuntimeProjectors(projectors: readonly Projector[]) {
  for (;;) {
    let processed = 0;
    for (const projector of projectors) {
      processed += (await projector.runOnce()).processed;
    }

    if (processed === 0) {
      return;
    }
  }
}
