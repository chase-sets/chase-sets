import { pathToFileURL } from "node:url";
import { validateProviderObjectDisposition } from "./validate-provider-object-disposition.mjs";
import { DISPOSITION_RECEIPT_POLICY } from "./disposition-receipt-policy.mjs";
import { WINDOW_SCHEDULE } from "./test-window-policy.mjs";
import { validateLaunchManifest } from "./test-window-admission.mjs";

export const refusedCapture = (code) => ({
  version: "provider-lifecycle-capture/v1",
  classification: "refused",
  code,
  replayQualified: false,
});

/** Only the operator entrypoint supplies this composition. Import and the bare
 * CLI never obtain authority, credentials, a database, or a browser. */
export async function captureEvidenceWindow(launch) {
  if (!launch || typeof launch.admit !== "function") return refusedCapture("authority-unavailable");
  let admission;
  let driver;
  try {
    admission = await launch.admit();
    validateLaunchManifest(admission, admission?.heads?.candidate);
    driver = await launch.open(admission);
  } catch {
    return refusedCapture("authority-unavailable");
  }
  const receipts = [];
  const observations = [];
  let classification = "unknown";
  let interrupted = false;
  try {
    if (
      !driver ||
      typeof driver.journal?.readWindow !== "function" ||
      typeof driver.dispose !== "function" ||
      !Array.isArray(driver.groups) ||
      driver.groups.length !== WINDOW_SCHEDULE.length
    )
      throw new Error("invalid-input");
    for (let index = 0; index < WINDOW_SCHEDULE.length; index++) {
      const group = driver.groups[index];
      const expected = WINDOW_SCHEDULE[index];
      if (
        group.flow !== expected.flow ||
        group.windowId !== admission.schedule[index].windowId ||
        JSON.stringify(group.scenarios?.map((scenario) => scenario.mapper)) !== JSON.stringify(expected.mappers)
      )
        throw new Error("invalid-input");
    }
    for (const group of driver.groups) {
      await group.open();
      let receipt;
      try {
        for (const scenario of group.scenarios) {
          await scenario.activate("original");
          try {
            await scenario.original();
          } catch {
            /* Accepted response withholding leaves persisted uncertainty. */
          }
          await scenario.waitForReplay();
          await scenario.activate("replay");
          let replayCompleted = false;
          try {
            await scenario.restartAndReplay();
            replayCompleted = true;
          } catch {
            /* No reconstructed key or replacement window. */
          }
          const sends = driver.sends().filter((entry) => entry.mapper === scenario.mapper);
          const first = sends.find((entry) => entry.phase === "original");
          const replay = sends.find((entry) => entry.phase === "replay");
          const equal = Boolean(
            first &&
            replay &&
            first.keyDigest === replay.keyDigest &&
            first.requestDigest === replay.requestDigest &&
            typeof first.responseDigest === "string" &&
            typeof replay.responseDigest === "string" &&
            first.responseDigest === replay.responseDigest &&
            first.replayDeadline === replay.replayDeadline,
          );
          let component = null;
          let repeatedSameSlot = null;
          let twoTabs = null;
          if (scenario.mapper.startsWith("connect-")) {
            await scenario.activate("repeat");
            const before = driver.sends().length;
            const repeat = await Promise.allSettled([scenario.repeatSameSlot()]);
            repeatedSameSlot =
              repeat[0].status === "rejected" && before === driver.sends().length ? "refused-zero-post" : "unknown";
            const tabs = await Promise.allSettled([scenario.repeatSameSlot(), scenario.repeatSameSlot()]);
            twoTabs =
              tabs.every((result) => result.status === "rejected") && before === driver.sends().length
                ? "refused-zero-post"
                : "unknown";
            // The real initialization attempt is independent of repeat qualification.
            // Expired/missing replay material remains missing, never a fabricated negative.
            component = await scenario.initializeIntendedComponent();
          } else if (scenario.mapper === "customer") await scenario.reuse();
          const elapsedSeconds =
            first && replay ? (replay.sendOffsetMilliseconds - first.sendOffsetMilliseconds) / 1000 : null;
          observations.push({
            mapper: scenario.mapper,
            originalSentAt: first?.sentAt ?? null,
            replaySentAt: replay?.sentAt ?? null,
            elapsedSeconds,
            equal,
            replayCompleted,
            expiresAt: replay?.expiresAt ?? first?.expiresAt ?? null,
            repeatedSameSlot,
            twoTabs,
            component,
            intervalSupported: equal && elapsedSeconds >= 5 && elapsedSeconds < admission.timing.retentionSeconds,
            usability: component?.usability ?? (scenario.mapper.startsWith("connect-") ? "unknown" : "not-applicable"),
          });
        }
      } finally {
        // Each flow has its own receipt and CAS close, including a failed flow.
        receipt = await group.dispose(DISPOSITION_RECEIPT_POLICY);
        if (!validateProviderObjectDisposition(receipt).ok || receipt.windowId !== group.windowId)
          throw new Error("cleanup-incomplete");
        receipts.push({ flow: group.flow, windowId: group.windowId, disposition: receipt });
        await group.close();
      }
    }
    if (
      observations.length === 6 &&
      receipts.length === 4 &&
      observations.every(
        (entry) =>
          entry.equal && entry.replayCompleted && (!entry.mapper.startsWith("connect-") || entry.component?.attempted),
      )
    )
      classification = "observed";
  } catch {
    interrupted = true;
  } finally {
    try {
      await driver?.dispose?.();
    } catch {
      interrupted = true;
    }
  }
  return {
    version: "provider-lifecycle-capture/v1",
    classification: interrupted ? "invalid" : classification,
    heads: admission.heads,
    configDigest: admission.configuration.configDigest,
    policyDigest: admission.configuration.policyDigest,
    deploymentEnvironment: admission.configuration.deploymentEnvironment,
    providerMode: "test",
    apiVersion: admission.configuration.apiVersion,
    attempts: driver?.counts?.() ?? null,
    logicalCreateUpperBound: driver?.creationCount?.() ?? null,
    observations,
    receipts,
    sends: driver?.sends?.() ?? [],
    lifecycle: driver?.lifecycle?.() ?? [],
    outstandingCleanup: admission.schedule
      .filter((flow) => !receipts.some((entry) => entry.flow === flow.flow && entry.disposition.variant === "success"))
      .map((flow) => ({ flow: flow.flow, obligations: flow.cleanupObligations })),
    replayQualified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(refusedCapture("authority-unavailable")) + "\n");
  process.exitCode = 2;
}
