import { Hono, type Context } from "hono";
import type { ChannelsApiEnv } from "../../../api";
import { ChannelSyncRunError } from "../../tcgplayer-csv/domain/contracts";
import { ManualSyncError, manualSyncIngestContract } from "../domain/contracts";
import type { ManualSyncServices } from "./runtime";

export function createManualSyncRoutes(services: ManualSyncServices) {
  const app = new Hono<ChannelsApiEnv>();

  app.get("/:connectionId/manual-sync", async (c) => {
    const panel = await services.readPanel({
      accountId: c.get("actor").accountId,
      connectionId: c.req.param("connectionId"),
    });
    return panel ? c.json(panel) : notFound(c);
  });

  app.post("/:connectionId/manual-sync/compose", async (c) => {
    if (!(await hasEmptyBody(c.req.raw))) return invalid(c);
    return execute(c, () =>
      services.compose(
        { accountId: c.get("actor").accountId, connectionId: c.req.param("connectionId") },
        c.get("context"),
      ),
    );
  });

  app.post("/:connectionId/manual-sync/runs/:runId/download", async (c) => {
    if (!(await hasEmptyBody(c.req.raw))) return invalid(c);
    return execute(c, async () => {
      const claimed = await services.claimAndDownload(
        {
          accountId: c.get("actor").accountId,
          connectionId: c.req.param("connectionId"),
          runId: c.req.param("runId"),
          expectedRevision: requiredRevision(c),
        },
        c.get("context"),
      );
      return new Response(claimed.batch.csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${claimed.fileName}"`,
          "x-channel-sync-run-revision": String(claimed.run.revision),
        },
      });
    });
  });

  app.post("/:connectionId/manual-sync/runs/:runId/release", async (c) => runFence(c, services.release));
  app.post("/:connectionId/manual-sync/runs/:runId/validation-cancelled", async (c) =>
    runFence(c, services.recordValidationCancellation),
  );

  app.post("/:connectionId/manual-sync/runs/:runId/upload-attempt", async (c) =>
    execute(c, async () => {
      const body = await readClosedJson(c.req.raw, ["expectedRevision", "uploadAttemptedAt", "fileName"]);
      return services.recordUploadAttempt(
        {
          accountId: c.get("actor").accountId,
          connectionId: c.req.param("connectionId"),
          runId: c.req.param("runId"),
          expectedRevision: safeRevision(body.expectedRevision),
          uploadAttemptedAt: requiredText(body.uploadAttemptedAt),
          fileName: requiredText(body.fileName),
        },
        c.get("context"),
      );
    }),
  );

  app.post("/:connectionId/manual-sync/ingest", async (c) =>
    execute(c, async () => {
      const surface = c.req.query("surface");
      if (surface !== "live" && surface !== "staged") throw new ManualSyncError("invalid-input");
      const upload = await readUpload(c.req.raw, surface);
      const capturedAt = c.req.header("x-channel-export-captured-at") ?? new Date().toISOString();
      const result = await services.ingest({
        accountId: c.get("actor").accountId,
        connectionId: c.req.param("connectionId"),
        surface,
        fileName: upload.fileName,
        bytes: upload.bytes,
        capturedAt,
        capturedAtSource: c.req.header("x-channel-export-captured-at") ? "operator-declared" : "ingest",
      });
      return result;
    }),
  );

  app.post("/:connectionId/manual-sync/runs/:runId/verify", async (c) =>
    execute(c, async () => {
      const body = await readClosedJson(c.req.raw, ["expectedRevision", "verificationSnapshotId", "importSummary"]);
      return services.verify(
        {
          accountId: c.get("actor").accountId,
          connectionId: c.req.param("connectionId"),
          runId: c.req.param("runId"),
          expectedRevision: safeRevision(body.expectedRevision),
          verificationSnapshotId: requiredText(body.verificationSnapshotId),
          importSummary: body.importSummary as never,
        },
        c.get("context"),
      );
    }),
  );

  return app;
}

async function runFence(
  c: Context<ChannelsApiEnv>,
  action: ManualSyncServices["release"] | ManualSyncServices["recordValidationCancellation"],
) {
  if (!(await hasEmptyBody(c.req.raw))) return invalid(c);
  return execute(c, () =>
    action(
      {
        accountId: c.get("actor").accountId,
        connectionId: requiredText(c.req.param("connectionId")),
        runId: requiredText(c.req.param("runId")),
        expectedRevision: requiredRevision(c),
      },
      c.get("context"),
    ),
  );
}

async function execute(c: Context<ChannelsApiEnv>, action: () => Promise<unknown>): Promise<Response> {
  try {
    const result = await action();
    return result instanceof Response ? result : c.json(result as never);
  } catch (error) {
    if (error instanceof ManualSyncError) {
      if (error.code === "connection-not-found") return notFound(c);
      if (error.code === "export-too-large") return c.json(errorBody(error.code), 413);
      return c.json(errorBody(error.code), error.code === "inbound-clamp-recovery" ? 409 : 400);
    }
    if (error instanceof ChannelSyncRunError) return c.json(errorBody(error.code), 409);
    throw error;
  }
}

async function readUpload(
  request: Request,
  surface: "live" | "staged",
): Promise<Readonly<{ fileName: string; bytes: Uint8Array }>> {
  const contentType = request.headers.get("content-type") ?? "";
  const multipart = contentType.toLowerCase().startsWith("multipart/form-data");
  const limit =
    surface === "live"
      ? multipart
        ? manualSyncIngestContract.founderProbeMultipartMaxBytes
        : manualSyncIngestContract.founderProbeMaxBytes
      : multipart
        ? manualSyncIngestContract.multipartMaxBytes
        : manualSyncIngestContract.maxBytes;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)) {
    throw new ManualSyncError("export-too-large");
  }
  const body = await readBoundedBody(request.body, limit);
  if (!multipart) {
    return {
      fileName: requiredText(request.headers.get("x-channel-export-file-name")),
      bytes: body,
    };
  }
  const parsed = await new Request("http://manual-sync.invalid/upload", {
    method: "POST",
    headers: { "content-type": contentType },
    body: new Blob([Uint8Array.from(body).buffer]),
  }).formData();
  if ([...parsed.keys()].some((key) => key !== "export") || parsed.getAll("export").length !== 1) {
    throw new ManualSyncError("invalid-input");
  }
  const file = parsed.get("export");
  const fileLimit =
    surface === "live" ? manualSyncIngestContract.founderProbeMaxBytes : manualSyncIngestContract.maxBytes;
  if (!(file instanceof File) || file.size > fileLimit) {
    throw new ManualSyncError("export-too-large");
  }
  return { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!stream) throw new ManualSyncError("invalid-input");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ManualSyncError("export-too-large");
    }
    chunks.push(chunk);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readClosedJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ManualSyncError("invalid-input");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManualSyncError("invalid-input");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new ManualSyncError("invalid-input");
  }
  return record;
}

function requiredRevision(c: Context<ChannelsApiEnv>): number {
  return safeRevision(c.req.query("expectedRevision"));
}

function safeRevision(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new ManualSyncError("invalid-input");
  return parsed as number;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new ManualSyncError("invalid-input");
  return value;
}

async function hasEmptyBody(request: Request) {
  return (await request.text()).length === 0;
}

function invalid(c: Context<ChannelsApiEnv>) {
  return c.json(errorBody("invalid-input"), 400);
}

function notFound(c: Context<ChannelsApiEnv>) {
  return c.json(errorBody("channel-connection-not-found"), 404);
}

function errorBody(code: string) {
  return { error: { code, message: code } };
}
