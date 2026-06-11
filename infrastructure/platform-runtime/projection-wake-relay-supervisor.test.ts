import { describe, expect, it } from "vitest";

import {
  startProjectionWakeRelaySupervisor,
  type ProjectionWakeRelayActiveSessionResult,
  type ProjectionWakeRelaySupervisorSessionEndedEvent,
} from "./projection-wake-relay";

function sessionResult(
  status: ProjectionWakeRelayActiveSessionResult["status"],
): ProjectionWakeRelayActiveSessionResult {
  return {
    status,
    leaseName: "projection-wake-relay:active",
    sourceContextNames: ["checkout"],
    caughtUpEventCount: 0,
    cursorAdvanceCount: 0,
  };
}

describe("projection wake relay supervisor", () => {
  it("retries standby sessions after lease misses until aborted", async () => {
    const abortController = new AbortController();
    const ended: ProjectionWakeRelaySupervisorSessionEndedEvent[] = [];
    let sessions = 0;

    const supervisor = startProjectionWakeRelaySupervisor({
      runSession: async () => {
        sessions += 1;
        if (sessions >= 3) {
          abortController.abort();
        }
        return sessionResult("lease-missed");
      },
      signal: abortController.signal,
      standbyRetryMs: 250,
      observer: { sessionEnded: (event) => ended.push(event) },
    });

    await supervisor.done;

    expect(sessions).toBe(3);
    expect(ended.every((event) => event.status === "lease-missed")).toBe(true);
    expect(supervisor.state()).toMatchObject({
      running: false,
      sessionCount: 3,
      lastSessionStatus: "lease-missed",
      lastError: null,
    });
  });

  it("waits the no-sources retry delay when the registry has no enabled sources", async () => {
    const abortController = new AbortController();
    const ended: ProjectionWakeRelaySupervisorSessionEndedEvent[] = [];
    let sessions = 0;

    const supervisor = startProjectionWakeRelaySupervisor({
      runSession: async () => {
        sessions += 1;
        if (sessions >= 2) {
          abortController.abort();
        }
        return sessionResult("no-enabled-sources");
      },
      signal: abortController.signal,
      standbyRetryMs: 250,
      noSourcesRetryMs: 300,
      observer: { sessionEnded: (event) => ended.push(event) },
    });

    await supervisor.done;

    expect(ended[0]).toMatchObject({ status: "no-enabled-sources", retryDelayMs: 300 });
  });

  it("applies exponential failure backoff and clears it after a successful session", async () => {
    const abortController = new AbortController();
    const ended: ProjectionWakeRelaySupervisorSessionEndedEvent[] = [];
    let sessions = 0;

    const supervisor = startProjectionWakeRelaySupervisor({
      runSession: async () => {
        sessions += 1;
        if (sessions <= 2) {
          throw new Error(`relay session crashed ${sessions}`);
        }
        if (sessions >= 3) {
          abortController.abort();
        }
        return sessionResult("lease-missed");
      },
      signal: abortController.signal,
      standbyRetryMs: 250,
      failureBackoffMs: 300,
      failureBackoffMaxMs: 1_000,
      observer: { sessionEnded: (event) => ended.push(event) },
    });

    await supervisor.done;

    expect(ended[0]).toMatchObject({ status: "error", retryDelayMs: 300 });
    expect(ended[1]).toMatchObject({ status: "error", retryDelayMs: 600 });
    expect(ended[2]).toMatchObject({ status: "lease-missed" });

    const supervisorState = supervisor.state();
    expect(supervisorState.lastSessionStatus).toBe("lease-missed");
    expect(supervisorState.lastError).toBeNull();
  });

  it("exits immediately when the supervisor signal is already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let sessions = 0;

    const supervisor = startProjectionWakeRelaySupervisor({
      runSession: async () => {
        sessions += 1;
        return sessionResult("stopped");
      },
      signal: abortController.signal,
    });

    await supervisor.done;

    expect(sessions).toBe(0);
    expect(supervisor.state()).toMatchObject({ running: false, sessionCount: 0, lastSessionStatus: null });
  });
});
