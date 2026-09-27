import { expect, it } from "vitest";
import { captureEvidenceWindow } from "./capture-evidence-window.mjs";
import { SCENARIO_FIXTURES } from "./validate-provider-object-disposition.mjs";
import { computeResultDigest } from "./canonicalize-provider-object-disposition.mjs";
import { syntheticManifest } from "./test-window-fixtures.mjs";

function syntheticLaunch() {
  const manifest = syntheticManifest();
  const history = [];
  const sends = [];
  let phase;
  let opened = 0;
  let componentAttempts = 0;
  const groups = manifest.schedule.map((flow) => ({
    flow: flow.flow,
    windowId: flow.windowId,
    open: async () => {
      expect(opened++).toBe(0);
      history.push(`open-${flow.flow}`);
    },
    close: async () => {
      expect(opened--).toBe(1);
      history.push(`close-${flow.flow}`);
    },
    dispose: async () => {
      history.push(`dispose-${flow.flow}`);
      const receipt = structuredClone(SCENARIO_FIXTURES.success);
      receipt.windowId = flow.windowId;
      receipt.resultDigest = computeResultDigest(receipt);
      return receipt;
    },
    scenarios: flow.mappers.map((mapper) => {
      const send = () =>
        sends.push({
          mapper,
          phase,
          sentAt: new Date(1700000000000 + (phase === "replay" ? 5000 : 0)).toISOString(),
          sendOffsetMilliseconds: phase === "replay" ? 5000 : 0,
          keyDigest: mapper,
          requestDigest: mapper,
          responseDigest: mapper,
          replayDeadline: "2099-01-01T00:00:00Z",
          expiresAt: null,
        });
      return {
        mapper,
        activate: async (next) => {
          phase = next;
        },
        original: async () => {
          send();
          throw new Error("SYNTHETIC_WITHHELD");
        },
        waitForReplay: async () => {},
        restartAndReplay: async () => {
          send();
        },
        reuse: async () => {},
        repeatSameSlot: async () => {
          throw new Error("SYNTHETIC_UNQUALIFIED");
        },
        initializeIntendedComponent: async () => {
          componentAttempts++;
          return { component: mapper, attempted: true, outcome: "policy-blocked", usability: "unknown" };
        },
      };
    }),
  }));
  const driver = {
    groups,
    journal: { readWindow: async () => [] },
    dispose: async () => history.push("closed-driver"),
    sends: () => sends,
    counts: () => ({ scenario: 12, browser: 3, disposition: 0, total: 15, denials: [] }),
    creationCount: () => 6,
  };
  return {
    manifest,
    driver,
    history,
    components: () => componentAttempts,
    admit: async () => manifest,
    open: async () => driver,
  };
}

it("AC-01 composition: six mappers in four independent sequential windows and four bound receipts", async () => {
  const launch = syntheticLaunch();
  const result = await captureEvidenceWindow(launch);
  expect(result.classification).toBe("observed");
  expect(result.replayQualified).toBe(false);
  expect(result.receipts.map((receipt) => receipt.flow)).toEqual(["P", "S", "M", "N"]);
  expect(result.observations).toHaveLength(6);
  expect(result.observations.every((entry) => entry.intervalSupported)).toBe(true);
  expect(launch.history).toEqual([
    "open-P",
    "dispose-P",
    "close-P",
    "open-S",
    "dispose-S",
    "close-S",
    "open-M",
    "dispose-M",
    "close-M",
    "open-N",
    "dispose-N",
    "close-N",
    "closed-driver",
  ]);
});

it("AC-04 lifecycle: unqualified repeat and two-tabs never suppress the three independent real-entrypoint calls", async () => {
  const launch = syntheticLaunch();
  const result = await captureEvidenceWindow(launch);
  expect(launch.components()).toBe(3);
  for (const entry of result.observations.slice(3)) {
    expect(entry.repeatedSameSlot).toBe("refused-zero-post");
    expect(entry.twoTabs).toBe("refused-zero-post");
    expect(entry.usability).toBe("unknown");
    expect(entry.component.attempted).toBe(true);
  }
});

it("AC-02 entrypoint: missing, staging, live, expired and mismatched authority cannot open composition", async () => {
  expect((await captureEvidenceWindow()).code).toBe("authority-unavailable");
  const changes = [
    (m) => {
      m.configuration.deploymentEnvironment = "staging";
    },
    (m) => {
      m.configuration.providerMode = "live";
    },
    (m) => {
      m.heads.executor = "b".repeat(40);
    },
    (m) => {
      m.timing.expiresAt = "2000-01-01T00:00:00Z";
    },
    (m) => {
      m.budgets.objects = 7;
    },
    (m) => {
      m.privateKey = "SYNTHETIC_PRIVATE_MARKER";
    },
  ];
  for (const change of changes) {
    const launch = syntheticLaunch();
    change(launch.manifest);
    let opens = 0;
    launch.open = async () => {
      opens++;
      throw new Error("SYNTHETIC_PRIVATE_MARKER");
    };
    expect((await captureEvidenceWindow(launch)).classification).toBe("refused");
    expect(opens).toBe(0);
  }
});

it("AC-05 budgets: missing mapper/foreign window never starts a schedule", async () => {
  for (const change of [
    (driver) => driver.groups[0].scenarios.pop(),
    (driver) => {
      driver.groups[1].windowId = "f".repeat(32);
    },
  ]) {
    const launch = syntheticLaunch();
    change(launch.driver);
    const result = await captureEvidenceWindow(launch);
    expect(result.classification).toBe("invalid");
    expect(result.receipts).toHaveLength(0);
    expect(launch.history).toEqual(["closed-driver"]);
    expect(result.outstandingCleanup).toHaveLength(4);
  }
});

it("AC-06 markers: interruption and cleanup failure retain counts/obligations, never raw exceptions", async () => {
  const launch = syntheticLaunch();
  launch.driver.groups[0].dispose = async () => {
    throw new Error("SYNTHETIC_PRIVATE_MARKER");
  };
  const result = await captureEvidenceWindow(launch);
  expect(result.classification).toBe("invalid");
  expect(result.attempts.total).toBe(15);
  expect(result.logicalCreateUpperBound).toBe(6);
  expect(result.outstandingCleanup).toHaveLength(4);
  expect(JSON.stringify(result).includes("SYNTHETIC_PRIVATE_MARKER")).toBe(false);
  expect(launch.history).toEqual(["open-P", "closed-driver"]);
});
