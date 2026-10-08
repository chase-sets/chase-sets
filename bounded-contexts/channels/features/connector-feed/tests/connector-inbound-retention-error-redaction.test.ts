import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createRetentionSweepLogObserver,
  createRetentionSweepRunner,
  type RetentionSweepLogger,
} from "@chase-sets/platform-runtime/retention-sweep";
import { connectorInboundRetentionSweeps } from "../read-model/retention-policy";

const SHIP_TO = "SENTINEL-SHIP-TO 8592 Evergreen Terrace, Springfield 73301";

// pg's DatabaseError echoes row values in message and detail.
class DatabaseError extends Error {
  readonly code = "23505";
  readonly detail = `Failing row contains (${SHIP_TO}).`;
}
class SystemError extends Error {
  readonly code = "ECONNRESET";
  readonly errno = -4077;
}

function capturingLogger() {
  const records: { level: "info" | "error"; message: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const logger: RetentionSweepLogger = {
    info: (message, fields) => records.push({ level: "info", message, fields }),
    error: (message, fields) => records.push({ level: "error", message, fields }),
  };
  return { logger, records };
}

async function runChannelsSweepsFailingWith(thrown: unknown, logger: RetentionSweepLogger) {
  const failing = {
    query: vi.fn(async () => {
      throw thrown;
    }),
  } as unknown as PgQueryable;
  const healthy = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as PgQueryable;
  const [exportSweep, orderSweep] = connectorInboundRetentionSweeps;
  if (!exportSweep || !orderSweep) throw new Error("missing-channels-sweeps");
  const recordScheduledRunnerCompleted = vi.fn().mockResolvedValue(undefined);
  const runner = createRetentionSweepRunner({
    controlPlane: { claimScheduledRunner: vi.fn().mockResolvedValue(true), recordScheduledRunnerCompleted },
    targets: [
      { contextName: "channels", db: failing, sweep: exportSweep },
      { contextName: "channels", db: healthy, sweep: orderSweep },
    ],
    observer: createRetentionSweepLogObserver(logger),
  });
  const result = await runner.runOnce();
  return { result, recordScheduledRunnerCompleted };
}

describe("connector-inbound-retention-error-redaction", () => {
  it.each([
    ["ship-to-bearing Error.message", new Error(`delete failed near ${SHIP_TO}`), "error", null],
    ["ship-to-bearing driver detail", new DatabaseError(`duplicate key ${SHIP_TO}`), "database-error", "23505"],
    ["ship-to-bearing errno error", new SystemError(`socket ${SHIP_TO}`), "system-error", "ECONNRESET"],
    ["ship-to-bearing TypeError cause", new TypeError("bad row", { cause: SHIP_TO }), "type-error", null],
    ["non-Error throw", { shipTo: SHIP_TO, toString: (): string => SHIP_TO }, "non-error", null],
    ["thrown string", SHIP_TO, "non-error", null],
  ])("the production observer logs only a bounded signal for a %s", async (_label, thrown, errorClass, errorCode) => {
    const { logger, records } = capturingLogger();
    const { result, recordScheduledRunnerCompleted } = await runChannelsSweepsFailingWith(thrown, logger);

    expect(JSON.stringify(records)).not.toContain("SENTINEL-SHIP-TO");
    expect(JSON.stringify(records)).not.toContain("73301");
    const failed = records.filter((record) => record.level === "error");
    expect(failed).toEqual([
      {
        level: "error",
        message: "Retention sweep failed; it will retry on its next interval.",
        fields: {
          type: "retention.sweep.failed",
          contextName: "channels",
          sweepName: "connector-inbound-inventory-snapshot",
          tableName: "channel_connector_inbound_payloads",
          errorClass,
          errorCode,
        },
      },
    ]);
    // The failure stays isolated: the other class still completes, and the failed one retries next interval.
    expect(result).toMatchObject({ processed: 1, state: "caught-up" });
    expect(recordScheduledRunnerCompleted).not.toHaveBeenCalledWith({
      runnerName: "retention.channels.connector-inbound-inventory-snapshot",
    });
    expect(recordScheduledRunnerCompleted).toHaveBeenCalledWith({
      runnerName: "retention.channels.connector-inbound-order-observation",
    });
  });

  it("the sentinel scan is red for the superseded raw-message logging shape", () => {
    const error = new Error(`delete failed near ${SHIP_TO}`);
    const superseded = {
      type: "retention.sweep.failed",
      contextName: "channels",
      error: error instanceof Error ? error.message : String(error),
    };
    expect(JSON.stringify(superseded)).toContain("SENTINEL-SHIP-TO");
  });

  it("a hostile error getter cannot escape as a runner failure", async () => {
    const hostile = new Error(SHIP_TO);
    Object.defineProperty(hostile, "code", {
      get: () => {
        throw new Error(SHIP_TO);
      },
    });
    const { logger, records } = capturingLogger();
    await expect(runChannelsSweepsFailingWith(hostile, logger)).resolves.toBeDefined();
    expect(JSON.stringify(records)).not.toContain("SENTINEL-SHIP-TO");
    expect(records.find((record) => record.level === "error")?.fields).toMatchObject({
      errorClass: "error",
      errorCode: null,
    });
  });
});
