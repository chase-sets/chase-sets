import { describe, expect, it } from "vitest";
import {
  parseIdentityNegativeControlsRecord,
  parseIdentityProbeRecord,
  parsePopupCapabilityProbeRecord,
} from "../src/probe-records";

const digest = "a".repeat(64);
const assignedId = "a".repeat(32);
const identity = {
  schemaVersion: 1,
  publicKeySha256: digest,
  distSha256: digest,
  chromiumVersion: "140.0.7339.0",
  assignedId,
  redirectUri: `https://${assignedId}.chromiumapp.org/ucp/oauth/callback`,
  capturedAt: "2026-09-12T14:00:00.000Z",
};
const capability = {
  schemaVersion: 1,
  publicKeySha256: digest,
  distSha256: digest,
  chromiumVersion: "140.0.7339.0",
  capturedAt: "2026-09-12T14:00:00.000Z",
  platformOrigin: "https://platform.invalid",
  trustedPopup: {
    actionPopupOpened: true,
    observationMode: "actual-action-popup",
    fallbackTabNavigationUsed: false,
    origin: `chrome-extension://${assignedId}`,
    storageLocalCanaryReadable: true,
    storageSessionCanaryReadable: true,
    indexedDbCanaryReadable: true,
    workerMessageReached: true,
  },
  sandboxedPopup: {
    setPopupSucceeded: true,
    actionPopupOpened: false,
    observationMode: "tab-navigation-fallback",
    fallbackTabNavigationUsed: true,
    origin: "null",
    chromeType: "undefined",
    storageLocalReachable: false,
    storageSessionReachable: false,
    indexedDbReachable: false,
    queryReceived: true,
    windowOpenReturnedWindow: false,
  },
  popupLessAction: {
    popupCleared: true,
    openPopupAttempted: true,
    openPopupRejected: true,
    actionTrigger: "Extensions.triggerAction",
    onClickedAfterOpenPopup: false,
    onClickedFired: true,
    badgeTextSucceeded: true,
    titleSucceeded: true,
  },
};
const controls = {
  schemaVersion: 1,
  baseline: { assignedId, distSha256: digest },
  keyRemoved: { assignedId: "b".repeat(32), distSha256: "b".repeat(64) },
  differentKey: { assignedId: "c".repeat(32), distSha256: "c".repeat(64) },
  mutationContract: "only manifest.key varied; key-removed omits it and different-key replaces it",
  capturedAt: "2026-09-12T14:00:00.000Z",
};

describe("extension-probe-record-schema", () => {
  it("accepts complete recursively closed identity and capability records", () => {
    expect(parseIdentityProbeRecord(identity)).toEqual(identity);
    expect(parseIdentityNegativeControlsRecord(controls)).toEqual(controls);
    expect(parsePopupCapabilityProbeRecord(capability)).toEqual(capability);
  });

  it("refuses partial and nested-unknown records", () => {
    expect(() => parsePopupCapabilityProbeRecord({})).toThrow("must contain exactly");
    expect(() =>
      parsePopupCapabilityProbeRecord({
        ...capability,
        trustedPopup: { ...capability.trustedPopup, manufacturedAuthority: true },
      }),
    ).toThrow("trustedPopup must contain exactly");
    expect(() =>
      parseIdentityNegativeControlsRecord({
        ...controls,
        differentKey: { ...controls.differentKey, nestedUnknown: true },
      }),
    ).toThrow("differentKey must contain exactly");
  });

  it("refuses tab observations promoted to actual popup proof and absent action stimuli", () => {
    expect(() =>
      parsePopupCapabilityProbeRecord({
        ...capability,
        sandboxedPopup: { ...capability.sandboxedPopup, observationMode: "actual-action-popup" },
      }),
    ).toThrow("observation mode must agree");
    expect(() =>
      parsePopupCapabilityProbeRecord({
        ...capability,
        popupLessAction: { ...capability.popupLessAction, actionTrigger: "openPopup" },
      }),
    ).toThrow("actionTrigger");
  });

  it("refuses date-only instants, empty origins, and non-boolean facts", () => {
    expect(() => parseIdentityProbeRecord({ ...identity, capturedAt: "2026-09-12" })).toThrow("UTC instant");
    expect(() =>
      parsePopupCapabilityProbeRecord({
        ...capability,
        trustedPopup: { ...capability.trustedPopup, origin: "" },
      }),
    ).toThrow("trustedPopup.origin must be a non-empty string");
    expect(() =>
      parsePopupCapabilityProbeRecord({
        ...capability,
        popupLessAction: { ...capability.popupLessAction, onClickedFired: "false" },
      }),
    ).toThrow("popupLessAction.onClickedFired must be a boolean");
  });
});
