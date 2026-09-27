import { closedObject, WINDOW_SCHEDULE } from "./test-window-policy.mjs";
import { parseStrictRfc3339, validateProviderObjectDisposition } from "./validate-provider-object-disposition.mjs";

const shape = (value, fields) =>
  closedObject(value, Object.keys(fields)) && Object.entries(fields).every(([key, check]) => check(value[key]));
const member =
  (...values) =>
  (value) =>
    values.includes(value);
const boolean = (value) => typeof value === "boolean";
const count = (maximum) => (value) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const hex = (length) => (value) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const utc = (value) => typeof value === "string" && value.endsWith("Z") && parseStrictRfc3339(value) !== null;
const nullable = (check) => (value) => value === null || check(value);
const array = (maximum, check) => (value) => Array.isArray(value) && value.length <= maximum && value.every(check);
const mapper = member(...WINDOW_SCHEDULE.flatMap((flow) => flow.mappers));
const flow = member("P", "S", "M", "N");
const variant = member("success", "pre-network-refusal", "cleanup-failure", "post-network-failure");
const componentFields = {
  component: member("account-onboarding", "account-management", "notification-banner"),
  attempted: boolean,
  outcome: member("policy-blocked", "error", "deadline", "unknown"),
  usability: member("unknown"),
};
const component = (value) =>
  shape(value, componentFields) ||
  shape(value, {
    ...componentFields,
    callbackInvocations: count(2),
    loaderStarted: boolean,
    created: boolean,
    mounted: boolean,
    startedAt: utc,
    finishedAt: nullable(utc),
    elapsedMilliseconds: count(3600000),
  });
const attempts = (value) =>
  shape(value, {
    scenario: count(128),
    browser: count(128),
    disposition: count(64),
    total: count(320),
    denials: array(80, (entry) =>
      shape(entry, {
        method: member("GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "other"),
        origin: member("connect-js", "js", "api", "merchant-ui-api", "other"),
        path: member("bootstrap", "other"),
        count: count(128),
      }),
    ),
  }) &&
  value.total === value.scenario + value.browser + value.disposition &&
  value.denials.reduce((sum, entry) => sum + entry.count, 0) <= value.browser;

export function validateCapturePacket(value) {
  try {
    const digest = Object.hasOwn(value, "manifestDigest") ? { manifestDigest: hex(64) } : {};
    if (
      shape(value, {
        version: member("provider-lifecycle-capture/v1"),
        classification: member("refused", "invalid"),
        code: member("authority-unavailable", "cleanup-obligation-retained", "child-interrupted", "packet-invalid"),
        replayQualified: member(false),
        ...digest,
      })
    )
      return true;
    return shape(value, {
      version: member("provider-lifecycle-capture/v1"),
      classification: member("observed", "unknown", "invalid"),
      heads: (heads) => shape(heads, { candidate: hex(40), executor: hex(40), journal: hex(40), deployed: hex(40) }),
      configDigest: hex(64),
      policyDigest: hex(64),
      deploymentEnvironment: member("dev", "test"),
      providerMode: member("test"),
      apiVersion: (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}\.[a-z]+$/.test(value),
      attempts: nullable(attempts),
      logicalCreateUpperBound: nullable(count(6)),
      observations: array(6, (entry) =>
        shape(entry, {
          mapper,
          originalSentAt: nullable(utc),
          replaySentAt: nullable(utc),
          elapsedSeconds: nullable(
            (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600,
          ),
          equal: boolean,
          replayCompleted: boolean,
          expiresAt: nullable(utc),
          repeatedSameSlot: nullable(member("refused-zero-post", "unknown")),
          twoTabs: nullable(member("refused-zero-post", "unknown")),
          component: nullable(component),
          intervalSupported: boolean,
          usability: member("unknown", "not-applicable"),
        }),
      ),
      receipts: array(
        4,
        (entry) =>
          shape(entry, {
            flow,
            windowId: hex(32),
            disposition: (receipt) => validateProviderObjectDisposition(receipt).ok,
          }) && entry.disposition.windowId === entry.windowId,
      ),
      sends: array(320, (entry) =>
        shape(entry, {
          mapper: nullable(mapper),
          phase: member("original", "replay", "repeat", "disposition"),
          sentAt: utc,
          sendOffsetMilliseconds: (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600000,
          keyDigest: hex(64),
          version: (value) => count(2147483647)(value) && value > 0,
          replayDeadline: utc,
          requestDigest: hex(64),
          responseDigest: nullable(hex(64)),
          withheld: boolean,
          expiresAt: nullable(utc),
        }),
      ),
      lifecycle: array(
        8,
        (entry) =>
          shape(entry, { flow, stage: member("terminal-repeat"), postCount: count(64), outcome: variant }) ||
          shape(entry, {
            flow: member("P"),
            stage: member("concurrent-cancel"),
            outcomes: array(2, (value) => value === "unknown" || variant(value)),
          }),
      ),
      outstandingCleanup: array(4, (entry) =>
        shape(entry, {
          flow,
          obligations: (obligations) =>
            JSON.stringify(obligations) ===
            JSON.stringify(
              entry.flow === "P"
                ? ["retain-customer", "cancel-eligible-intents", "retain-captured-remedy"]
                : ["retain-session-expiry"],
            ),
        }),
      ),
      replayQualified: member(false),
      ...digest,
    });
  } catch {
    return false;
  }
}
