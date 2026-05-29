import type { BcApiModule, BcApiMount } from "@chase-sets/bounded-context-module";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeFreshWriteReceipt,
  encodeCommitReceipt,
  type FreshWriteReceipt,
} from "@chase-sets/http/responses";

export type ResolvedApiMount<TRouter = unknown> = BcApiMount &
  Readonly<{
    contextName: string;
    router: TRouter;
  }>;

type ReadConsistencySubscriptionRunner = Readonly<{
  sourceContextName: string;
  refreshStatus: () => Promise<Readonly<{ lastGlobalPosition: string; state: string; lastError?: string | null }>>;
}>;

export type ReadConsistencyProjectionGroup = Readonly<{
  targetContextName: string;
  projectionName: string;
  subscriptionRunners: readonly ReadConsistencySubscriptionRunner[];
}>;

export class ProjectionFreshnessTimeoutError extends Error {
  public constructor(
    public readonly details: Readonly<{
      targetContextNames: readonly string[];
      pending: readonly Readonly<{
        targetContextName: string;
        projectionName: string;
        sourceContextName: string;
        requiredGlobalPosition: string;
        lastGlobalPosition: string;
        state: string;
        lastError: string | null;
      }>[];
    }>,
  ) {
    super("Projection read model did not catch up to the requested write receipt before the freshness timeout.");
    this.name = "ProjectionFreshnessTimeoutError";
  }
}

export function createResolvedApiMount<TRouter>(
  contextName: string,
  mount: Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
  }>,
  router: TRouter,
): ResolvedApiMount<TRouter> {
  if (mount.kind !== "primary" && mount.kind !== "additional") {
    throw new Error(`Invalid API mount kind '${mount.kind}' for context '${contextName}'.`);
  }

  return {
    contextName,
    mountPath: mount.mountPath,
    kind: mount.kind,
    requiresAuth: mount.requiresAuth,
    router,
  };
}

export function resolveContextApiMounts<TRouter>(
  contextName: string,
  mounts: readonly Readonly<{
    mountPath: string;
    kind: string;
    requiresAuth: boolean;
  }>[],
  routers: readonly TRouter[],
): readonly ResolvedApiMount<TRouter>[] {
  if (mounts.length !== routers.length) {
    throw new Error(
      `Context '${contextName}' declared ${mounts.length} API mounts but provided ${routers.length} routers.`,
    );
  }

  return mounts.map((mount, index) => createResolvedApiMount(contextName, mount, routers[index]));
}

export function resolveModuleApiMounts<TServices, TPool, TPorts, TRouter>(
  module: Pick<BcApiModule<TServices, TPool, TPorts, TRouter>, "contextName" | "apiMounts" | "buildApis">,
  services: TServices,
): readonly ResolvedApiMount<TRouter>[] {
  return resolveContextApiMounts(module.contextName, module.apiMounts, module.buildApis(services));
}

function normalizeMountWildcard(mountPath: string) {
  return mountPath.endsWith("/*") ? mountPath : `${mountPath}/*`;
}

function uniqueMountPaths(paths: readonly string[]) {
  return [...new Set(paths)];
}

export function attachApiMountMiddleware(
  app: Readonly<{
    use(path: string, middleware: unknown): unknown;
  }>,
  mountPaths: readonly string[],
  middleware: unknown,
): void {
  for (const mountPath of uniqueMountPaths(mountPaths)) {
    app.use(normalizeMountWildcard(mountPath), middleware);
  }
}

export function attachWriteConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<void>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "mountPath">[],
): void {
  for (const mountPath of uniqueMountPaths(mounts.map((mount) => mount.mountPath))) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      await runWithEventCommitMetadata(next);

      const req = (context as { req?: { method?: string } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method === "GET" || method === "HEAD") {
        return;
      }

      const metadata = getEventCommitMetadata();
      if (metadata.eventIds.length === 0) {
        return;
      }

      const header = (context as { header?: (name: string, value: string) => void }).header;
      if (!header) {
        return;
      }

      header("Chase-Sets-Consistency", "eventual");
      if (metadata.maxGlobalPosition) {
        header("Chase-Sets-Commit-Position", metadata.maxGlobalPosition);
      }

      if (metadata.sources.length > 0) {
        header(CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt(metadata.sources));
      }

      const compactEventIds = metadata.eventIds.join(",");
      if (compactEventIds.length <= 4_000) {
        header("Chase-Sets-Commit-Event-Ids", compactEventIds);
      }
    });
  }
}

export async function waitForProjectionFreshness(
  input: Readonly<{
    projectionGroups: readonly ReadConsistencyProjectionGroup[];
    targetContextNames: readonly string[];
    receipt: FreshWriteReceipt;
    timeoutMs?: number;
    pollIntervalMs?: number;
    nowMs?: () => number;
  }>,
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 2_500;
  const pollIntervalMs = input.pollIntervalMs ?? 75;
  const nowMs = input.nowMs ?? Date.now;
  const startedAt = nowMs();
  const targetContextNames = [...new Set(input.targetContextNames)];

  while (true) {
    const pending = await findPendingProjectionFreshness({
      projectionGroups: input.projectionGroups,
      targetContextNames,
      receipt: input.receipt,
    });

    if (pending.length === 0) {
      return;
    }

    if (nowMs() - startedAt >= timeoutMs) {
      throw new ProjectionFreshnessTimeoutError({ targetContextNames, pending });
    }

    await delay(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (nowMs() - startedAt))));
  }
}

async function findPendingProjectionFreshness(
  input: Readonly<{
    projectionGroups: readonly ReadConsistencyProjectionGroup[];
    targetContextNames: readonly string[];
    receipt: FreshWriteReceipt;
  }>,
) {
  const targetContextNameSet = new Set(input.targetContextNames);
  const pending: {
    targetContextName: string;
    projectionName: string;
    sourceContextName: string;
    requiredGlobalPosition: string;
    lastGlobalPosition: string;
    state: string;
    lastError: string | null;
  }[] = [];

  for (const group of input.projectionGroups) {
    if (!targetContextNameSet.has(group.targetContextName)) {
      continue;
    }

    for (const source of input.receipt.sources) {
      for (const runner of group.subscriptionRunners.filter(
        (candidate) => candidate.sourceContextName === source.sourceContextName,
      )) {
        const status = await runner.refreshStatus();
        if (BigInt(status.lastGlobalPosition) >= BigInt(source.maxGlobalPosition)) {
          continue;
        }

        pending.push({
          targetContextName: group.targetContextName,
          projectionName: group.projectionName,
          sourceContextName: source.sourceContextName,
          requiredGlobalPosition: source.maxGlobalPosition,
          lastGlobalPosition: status.lastGlobalPosition,
          state: status.state,
          lastError: status.lastError ?? null,
        });
      }
    }
  }

  return pending;
}

export function attachReadConsistencyMiddleware(
  app: Readonly<{
    use(path: string, middleware: (context: unknown, next: () => Promise<void>) => Promise<unknown>): unknown;
  }>,
  mounts: readonly Pick<ResolvedApiMount, "contextName" | "mountPath">[],
  projectionGroups: readonly ReadConsistencyProjectionGroup[],
  options: Readonly<{ timeoutMs?: number; pollIntervalMs?: number }> = {},
): void {
  const contextsByMountPath = new Map<string, string[]>();
  for (const mount of mounts) {
    contextsByMountPath.set(mount.mountPath, [...(contextsByMountPath.get(mount.mountPath) ?? []), mount.contextName]);
  }

  for (const [mountPath, contextNames] of contextsByMountPath) {
    app.use(normalizeMountWildcard(mountPath), async (context: unknown, next) => {
      const req = (context as { req?: { method?: string; header?: (name: string) => string | undefined } }).req;
      const method = req?.method?.toUpperCase() ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        await next();
        return;
      }

      const receipt = decodeFreshWriteReceipt(req?.header?.(CHASE_SETS_READ_AFTER_WRITE_HEADER));
      if (!receipt || receipt.sources.length === 0) {
        await next();
        return;
      }

      const requestedTargetContextName = req?.header?.(CHASE_SETS_READ_TARGET_CONTEXT_HEADER);
      const targetContextNames =
        requestedTargetContextName && contextNames.includes(requestedTargetContextName)
          ? [requestedTargetContextName]
          : contextNames;

      try {
        await waitForProjectionFreshness({
          projectionGroups,
          targetContextNames,
          receipt,
          timeoutMs: options.timeoutMs,
          pollIntervalMs: options.pollIntervalMs,
        });
      } catch (error) {
        if (error instanceof ProjectionFreshnessTimeoutError) {
          const json = (context as { json?: (body: unknown, status?: number) => unknown }).json;
          if (json) {
            return json(
              {
                error: {
                  code: "projection_freshness_timeout",
                  message: error.message,
                  pending: error.details.pending,
                },
              },
              503,
            );
          }
        }

        throw error;
      }

      await next();
    });
  }
}

export function mountApiRouters(
  app: Readonly<{
    route(path: string, router: unknown): unknown;
  }>,
  mounts: readonly ResolvedApiMount[],
): void {
  for (const mount of mounts) {
    app.route(mount.mountPath, mount.router);
  }
}

export function createForwardedAuthHeaders(request: Request, initHeaders?: HeadersInit): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const url = new URL(request.url);
  return `${url.origin}${apiBasePath}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
