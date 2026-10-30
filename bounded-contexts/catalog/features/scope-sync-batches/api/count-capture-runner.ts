import { z } from "zod";
import {
  countCaptureAuthoritySchema,
  countLifecycleStopReceiptSchema,
  countLifecycleReceiptSchema,
  classifyCountLifecycleReceipt,
  validateCountCaptureAuthority,
  validateCountLifecycleReceipt,
  type CountCaptureAuthority,
  type CountLifecycleStopReceipt,
} from "../domain/count-lifecycle-receipt";
import { countQuoteSchema } from "../domain/count-acquisition";

const identitySchema = z
  .object({
    sha: z.string().regex(/^[a-f0-9]{40}$/),
    dispatchId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    scopeRecordId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  })
  .strict();
const baselineSchema = z
  .object({
    authority: countCaptureAuthoritySchema,
    baseline: z
      .object({
        selection: z.object({ scopeRecordId: z.string().min(1) }).passthrough(),
        units: z.array(z.object({ unitKey: z.string().min(1) }).passthrough()).length(3),
        countAuthority: z.object({
          fingerprint: z.string().min(1),
          headroom: z.number().nullable(),
          allowed: z.boolean(),
        }),
        effects: z
          .object({
            at: z.string().datetime({ offset: true }),
            batches: z.number(),
            reservations: z.number(),
            jobs: z.number(),
            enqueues: z.number(),
            imports: z.number(),
          })
          .strict(),
      })
      .passthrough(),
    providerSends: z.number().int().nonnegative(),
  })
  .passthrough();
const acknowledgementSchema = z.object({}).passthrough();
const sealSchema = z.object({ runId: z.uuid(), frozenAt: z.iso.datetime({ offset: true }) }).strict();
// The runner's own clock may trail the server seal by at most one action deadline
// (the staging script's 30 s); beyond it the boundary cannot be honored.
export const countCaptureBoundaryWaitMs = 30_000;

export type CountCaptureAction = (intent: string, fields: Readonly<Record<string, string>>) => Promise<unknown>;
export type CountCaptureDeploymentCollection = (
  deployment: CountCaptureAuthority["deployment"],
  now: string,
) => Promise<CountCaptureAuthority["collection"]>;

// This driver has no confirm/import/retry capability. The server independently
// owns session admission, phase transitions, notices and possible-send debits.
export async function runCountCaptureJourney(
  identity: z.infer<typeof identitySchema>,
  action: CountCaptureAction,
  now = () => new Date().toISOString(),
  collectDeployment?: CountCaptureDeploymentCollection,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  let phase: CountLifecycleStopReceipt["phase"] = "baseline";
  const stop = (reason: CountLifecycleStopReceipt["reason"]): CountLifecycleStopReceipt =>
    ({
      schemaVersion: "scope-sync-count-lifecycle-stop/v1",
      stoppedAt: now(),
      phase,
      reason,
      evidence: {},
    }) as CountLifecycleStopReceipt;
  if (!identitySchema.safeParse(identity).success) return stop("authority-unbound");
  try {
    const baseline = baselineSchema.parse(await action("capture-baseline", identity));
    if (
      baseline.authority.runnerSha !== identity.sha ||
      baseline.authority.dispatchId !== identity.dispatchId ||
      baseline.baseline.selection.scopeRecordId !== identity.scopeRecordId ||
      new Set(baseline.baseline.units.map((unit) => unit.unitKey)).size !== 3 ||
      !validateCountCaptureAuthority(baseline.authority, now()).ok ||
      baseline.providerSends !== 0
    )
      return stop("authority-unbound");
    if (!collectDeployment) return stop("deployment-unknown");
    const collection = await collectDeployment(baseline.authority.deployment, now());
    if ((collection as { complete?: boolean } | null)?.complete === false) return stop("deployment-unknown");
    if (!validateCountCaptureAuthority({ ...baseline.authority, collection }, now()).ok)
      return stop("deployment-unknown");
    acknowledgementSchema.parse(await action("capture-initial-notice", {}));
    phase = "bootstrap";
    acknowledgementSchema.parse(await action("capture-usage", {}));
    phase = "quote";
    const quote = countQuoteSchema.parse(await action("count-quote", {}));
    if (quote.cap !== quote.plannedCredits) return stop("capture-stopped");
    const readBackResponse = await action("capture-quote-readback", {});
    const readBack = countQuoteSchema.parse((readBackResponse as { quote?: unknown }).quote);
    if (JSON.stringify(readBack) !== JSON.stringify(quote)) return stop("capture-stopped");
    acknowledgementSchema.parse(await action("capture-final-notice", {}));
    phase = "acquisition";
    acknowledgementSchema.parse(
      await action("count-acquire", {
        quoteId: quote.quoteId,
        countFingerprint: quote.fingerprint,
      }),
    );
    phase = "preview";
    const preview = z
      .object({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await action("preview", {}));
    phase = "pre-confirm";
    acknowledgementSchema.parse(await action("pre-confirm-planner-read", { planFingerprint: preview.planFingerprint }));
    phase = "freeze";
    // Seal first: the server fixes frozenAt and fences every later send. The one
    // final collection starts only once this runner's clock has reached that
    // boundary, so its inventory covers the deployment up to the seal.
    const sealed = sealSchema.parse(await action("capture-freeze", { dispatchId: identity.dispatchId }));
    const boundary = Date.parse(sealed.frozenAt);
    let collectedAt = now();
    let waited = 0;
    while (Date.parse(collectedAt) < boundary) {
      const lag = boundary - Date.parse(collectedAt);
      if (waited + lag > countCaptureBoundaryWaitMs) return stop("deployment-unknown");
      waited += lag;
      await sleep(lag);
      collectedAt = now();
    }
    let freezeCollection: CountCaptureAuthority["collection"];
    try {
      freezeCollection = await collectDeployment(baseline.authority.deployment, collectedAt);
    } catch {
      return stop("deployment-unknown");
    }
    const completed = await action("capture-complete", {
      runId: sealed.runId,
      dispatchId: identity.dispatchId,
      collection: JSON.stringify(freezeCollection),
    });
    const raw = (completed as { receipt?: unknown })?.receipt ?? completed;
    const stopped = countLifecycleStopReceiptSchema.safeParse(raw);
    // Return the server envelope unchanged; schema defaults are validation-only
    // and must not rewrite a retained stop receipt on the runner path.
    if (stopped.success && validateCountLifecycleReceipt(stopped.data).valid) return stopped.data;
    const parsed = countLifecycleReceiptSchema.parse(raw);
    if (
      parsed.authority.runnerSha !== identity.sha ||
      parsed.authority.dispatchId !== identity.dispatchId ||
      parsed.selection.scopeRecordId !== identity.scopeRecordId ||
      parsed.frozenAt !== sealed.frozenAt ||
      JSON.stringify(parsed.freezeCollection) !== JSON.stringify(freezeCollection) ||
      !validateCountLifecycleReceipt(parsed).valid
    )
      return countLifecycleStopReceiptSchema.parse({
        schemaVersion: "scope-sync-count-lifecycle-stop/v1",
        attribution: parsed.attribution,
        stoppedAt: parsed.frozenAt,
        phase: "freeze",
        reason: "missing-observation",
        evidence: {
          startedAt: parsed.startedAt,
          frozenAt: parsed.frozenAt,
          sends: parsed.sends,
          effects: parsed.effects,
        },
        classification: classifyCountLifecycleReceipt({
          schemaVersion: "scope-sync-count-lifecycle-stop/v1",
          attribution: parsed.attribution,
          stoppedAt: parsed.frozenAt,
          phase: "freeze",
          reason: "missing-observation",
          evidence: {
            startedAt: parsed.startedAt,
            frozenAt: parsed.frozenAt,
            sends: parsed.sends,
            effects: parsed.effects,
          },
          classification: parsed.classification,
        }),
      });
    return parsed;
  } catch {
    // No follow-up action is safe after an uncertain send. Durable server
    // accounting remains authoritative; absent final evidence stays absent.
    return stop("capture-stopped");
  }
}
