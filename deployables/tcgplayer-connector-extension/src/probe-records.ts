export type IdentityProbeRecord = Readonly<{
  schemaVersion: 1;
  publicKeySha256: string;
  distSha256: string;
  chromiumVersion: string;
  assignedId: string;
  redirectUri: string;
  capturedAt: string;
}>;

type IdentityMutantFacts = Readonly<{ assignedId: string; distSha256: string }>;

export type IdentityNegativeControlsRecord = Readonly<{
  schemaVersion: 1;
  baseline: IdentityMutantFacts;
  keyRemoved: IdentityMutantFacts;
  differentKey: IdentityMutantFacts;
  mutationContract: "only manifest.key varied; key-removed omits it and different-key replaces it";
  capturedAt: string;
}>;

export type PopupObservationMode = "actual-action-popup" | "tab-navigation-fallback";

export type PopupCapabilityProbeRecord = Readonly<{
  schemaVersion: 1;
  publicKeySha256: string;
  distSha256: string;
  chromiumVersion: string;
  capturedAt: string;
  platformOrigin: string;
  trustedPopup: Readonly<{
    actionPopupOpened: boolean;
    observationMode: PopupObservationMode;
    fallbackTabNavigationUsed: boolean;
    origin: string;
    storageLocalCanaryReadable: boolean;
    storageSessionCanaryReadable: boolean;
    indexedDbCanaryReadable: boolean;
    workerMessageReached: boolean;
  }>;
  sandboxedPopup: Readonly<{
    setPopupSucceeded: boolean;
    actionPopupOpened: boolean;
    observationMode: PopupObservationMode;
    fallbackTabNavigationUsed: boolean;
    origin: string;
    chromeType: string;
    storageLocalReachable: boolean;
    storageSessionReachable: boolean;
    indexedDbReachable: boolean;
    queryReceived: boolean;
    windowOpenReturnedWindow: boolean;
  }>;
  popupLessAction: Readonly<{
    popupCleared: boolean;
    openPopupAttempted: boolean;
    openPopupRejected: boolean;
    onClickedFired: boolean;
    badgeTextSucceeded: boolean;
    titleSucceeded: boolean;
  }>;
}>;

const sha256Pattern = /^[a-f0-9]{64}$/;
const chromiumVersionPattern = /^\d+\.\d+\.\d+\.\d+$/;
const extensionIdPattern = /^[a-p]{32}$/;
const utcInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const candidate = value as Record<string, unknown>;
  const actualKeys = Object.keys(candidate).sort();
  const expectedKeys = [...keys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${name} must contain exactly: ${expectedKeys.join(", ")}`);
  }
  return candidate;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function sha256(value: unknown, name: string): string {
  const parsed = string(value, name);
  if (!sha256Pattern.test(parsed)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return parsed;
}

function chromiumVersion(value: unknown): string {
  const parsed = string(value, "chromiumVersion");
  if (!chromiumVersionPattern.test(parsed)) throw new Error("chromiumVersion must contain four dot-separated integers");
  return parsed;
}

function capturedAt(value: unknown): string {
  const parsed = string(value, "capturedAt");
  if (!utcInstantPattern.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new Error("capturedAt must be a millisecond UTC instant ending in Z");
  }
  return parsed;
}

function schemaVersion(value: unknown): 1 {
  if (value !== 1) throw new Error("schemaVersion must be 1");
  return 1;
}

function observationMode(value: unknown, name: string): PopupObservationMode {
  if (value !== "actual-action-popup" && value !== "tab-navigation-fallback") {
    throw new Error(`${name} must name the actual action popup or the tab-navigation fallback`);
  }
  return value;
}

export function parseIdentityProbeRecord(value: unknown): IdentityProbeRecord {
  const record = exactObject(
    value,
    ["schemaVersion", "publicKeySha256", "distSha256", "chromiumVersion", "assignedId", "redirectUri", "capturedAt"],
    "identity record",
  );
  const assignedId = string(record.assignedId, "assignedId");
  if (!extensionIdPattern.test(assignedId)) throw new Error("assignedId must be a 32-character Chromium extension id");
  const redirectUri = string(record.redirectUri, "redirectUri");
  if (redirectUri !== `https://${assignedId}.chromiumapp.org/ucp/oauth/callback`) {
    throw new Error("redirectUri must be Chromium's exact callback for assignedId");
  }
  return {
    schemaVersion: schemaVersion(record.schemaVersion),
    publicKeySha256: sha256(record.publicKeySha256, "publicKeySha256"),
    distSha256: sha256(record.distSha256, "distSha256"),
    chromiumVersion: chromiumVersion(record.chromiumVersion),
    assignedId,
    redirectUri,
    capturedAt: capturedAt(record.capturedAt),
  };
}

function parseIdentityMutantFacts(value: unknown, name: string): IdentityMutantFacts {
  const facts = exactObject(value, ["assignedId", "distSha256"], name);
  const assignedId = string(facts.assignedId, `${name}.assignedId`);
  if (!extensionIdPattern.test(assignedId)) {
    throw new Error(`${name}.assignedId must be a 32-character Chromium extension id`);
  }
  return { assignedId, distSha256: sha256(facts.distSha256, `${name}.distSha256`) };
}

export function parseIdentityNegativeControlsRecord(value: unknown): IdentityNegativeControlsRecord {
  const record = exactObject(
    value,
    ["schemaVersion", "baseline", "keyRemoved", "differentKey", "mutationContract", "capturedAt"],
    "identity negative controls",
  );
  const mutationContract = string(record.mutationContract, "mutationContract");
  if (mutationContract !== "only manifest.key varied; key-removed omits it and different-key replaces it") {
    throw new Error("mutationContract must name the two finite one-input mutants");
  }
  return {
    schemaVersion: schemaVersion(record.schemaVersion),
    baseline: parseIdentityMutantFacts(record.baseline, "baseline"),
    keyRemoved: parseIdentityMutantFacts(record.keyRemoved, "keyRemoved"),
    differentKey: parseIdentityMutantFacts(record.differentKey, "differentKey"),
    mutationContract,
    capturedAt: capturedAt(record.capturedAt),
  };
}

export function parsePopupCapabilityProbeRecord(value: unknown): PopupCapabilityProbeRecord {
  const record = exactObject(
    value,
    [
      "schemaVersion",
      "publicKeySha256",
      "distSha256",
      "chromiumVersion",
      "capturedAt",
      "platformOrigin",
      "trustedPopup",
      "sandboxedPopup",
      "popupLessAction",
    ],
    "popup capability record",
  );
  const trusted = exactObject(
    record.trustedPopup,
    [
      "actionPopupOpened",
      "observationMode",
      "fallbackTabNavigationUsed",
      "origin",
      "storageLocalCanaryReadable",
      "storageSessionCanaryReadable",
      "indexedDbCanaryReadable",
      "workerMessageReached",
    ],
    "trustedPopup",
  );
  const sandboxed = exactObject(
    record.sandboxedPopup,
    [
      "setPopupSucceeded",
      "actionPopupOpened",
      "observationMode",
      "fallbackTabNavigationUsed",
      "origin",
      "chromeType",
      "storageLocalReachable",
      "storageSessionReachable",
      "indexedDbReachable",
      "queryReceived",
      "windowOpenReturnedWindow",
    ],
    "sandboxedPopup",
  );
  const popupLess = exactObject(
    record.popupLessAction,
    [
      "popupCleared",
      "openPopupAttempted",
      "openPopupRejected",
      "onClickedFired",
      "badgeTextSucceeded",
      "titleSucceeded",
    ],
    "popupLessAction",
  );

  const trustedMode = observationMode(trusted.observationMode, "trustedPopup.observationMode");
  const trustedOpened = boolean(trusted.actionPopupOpened, "trustedPopup.actionPopupOpened");
  const trustedFallback = boolean(trusted.fallbackTabNavigationUsed, "trustedPopup.fallbackTabNavigationUsed");
  if (
    (trustedMode === "actual-action-popup") !== trustedOpened ||
    (trustedMode === "tab-navigation-fallback") !== trustedFallback
  ) {
    throw new Error("trustedPopup observation mode must agree with popup and fallback facts");
  }
  const sandboxedMode = observationMode(sandboxed.observationMode, "sandboxedPopup.observationMode");
  const sandboxedOpened = boolean(sandboxed.actionPopupOpened, "sandboxedPopup.actionPopupOpened");
  const sandboxedFallback = boolean(sandboxed.fallbackTabNavigationUsed, "sandboxedPopup.fallbackTabNavigationUsed");
  if (
    (sandboxedMode === "actual-action-popup") !== sandboxedOpened ||
    (sandboxedMode === "tab-navigation-fallback") !== sandboxedFallback
  ) {
    throw new Error("sandboxedPopup observation mode must agree with popup and fallback facts");
  }

  return {
    schemaVersion: schemaVersion(record.schemaVersion),
    publicKeySha256: sha256(record.publicKeySha256, "publicKeySha256"),
    distSha256: sha256(record.distSha256, "distSha256"),
    chromiumVersion: chromiumVersion(record.chromiumVersion),
    capturedAt: capturedAt(record.capturedAt),
    platformOrigin: string(record.platformOrigin, "platformOrigin"),
    trustedPopup: {
      actionPopupOpened: trustedOpened,
      observationMode: trustedMode,
      fallbackTabNavigationUsed: trustedFallback,
      origin: string(trusted.origin, "trustedPopup.origin"),
      storageLocalCanaryReadable: boolean(
        trusted.storageLocalCanaryReadable,
        "trustedPopup.storageLocalCanaryReadable",
      ),
      storageSessionCanaryReadable: boolean(
        trusted.storageSessionCanaryReadable,
        "trustedPopup.storageSessionCanaryReadable",
      ),
      indexedDbCanaryReadable: boolean(trusted.indexedDbCanaryReadable, "trustedPopup.indexedDbCanaryReadable"),
      workerMessageReached: boolean(trusted.workerMessageReached, "trustedPopup.workerMessageReached"),
    },
    sandboxedPopup: {
      setPopupSucceeded: boolean(sandboxed.setPopupSucceeded, "sandboxedPopup.setPopupSucceeded"),
      actionPopupOpened: sandboxedOpened,
      observationMode: sandboxedMode,
      fallbackTabNavigationUsed: sandboxedFallback,
      origin: string(sandboxed.origin, "sandboxedPopup.origin"),
      chromeType: string(sandboxed.chromeType, "sandboxedPopup.chromeType"),
      storageLocalReachable: boolean(sandboxed.storageLocalReachable, "sandboxedPopup.storageLocalReachable"),
      storageSessionReachable: boolean(sandboxed.storageSessionReachable, "sandboxedPopup.storageSessionReachable"),
      indexedDbReachable: boolean(sandboxed.indexedDbReachable, "sandboxedPopup.indexedDbReachable"),
      queryReceived: boolean(sandboxed.queryReceived, "sandboxedPopup.queryReceived"),
      windowOpenReturnedWindow: boolean(sandboxed.windowOpenReturnedWindow, "sandboxedPopup.windowOpenReturnedWindow"),
    },
    popupLessAction: {
      popupCleared: boolean(popupLess.popupCleared, "popupLessAction.popupCleared"),
      openPopupAttempted: boolean(popupLess.openPopupAttempted, "popupLessAction.openPopupAttempted"),
      openPopupRejected: boolean(popupLess.openPopupRejected, "popupLessAction.openPopupRejected"),
      onClickedFired: boolean(popupLess.onClickedFired, "popupLessAction.onClickedFired"),
      badgeTextSucceeded: boolean(popupLess.badgeTextSucceeded, "popupLessAction.badgeTextSucceeded"),
      titleSucceeded: boolean(popupLess.titleSucceeded, "popupLessAction.titleSucceeded"),
    },
  };
}
