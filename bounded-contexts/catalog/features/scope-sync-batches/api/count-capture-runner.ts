import { z } from "zod";
import { countCapturePlannerInputSchema } from "../domain/count-capture-plan";
import {
  countCaptureAuthoritySchema,
  countLifecycleReceiptSchema,
  validateCountCaptureAuthority,
  validateCountLifecycleReceipt,
  type CountCaptureAuthority,
  type CountLifecycleStopReceipt,
} from "../domain/count-lifecycle-receipt";

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
    selection: countLifecycleReceiptSchema.shape.selection,
    units: countLifecycleReceiptSchema.shape.units,
    effects: countLifecycleReceiptSchema.shape.effects,
    plannerInput: countCapturePlannerInputSchema,
    bootstrapRequired: z.boolean(),
    providerEgressDenied: z.literal(true),
  })
  .strict();
const acknowledgementSchema = z.object({ retained: z.literal(true) }).strict();
const preConfirmSchema = z
  .object({
    comparedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    currentFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    eligible: z.boolean(),
    refusal: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
      .nullable(),
    effectsCapability: z.literal(false),
  })
  .strict();
const quoteSchema = z
  .object({
    quoteId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    plannedCount: z.number().int().min(0).max(2),
    serverCap: z.number().int().min(0).max(2),
  })
  .strict();

export type CountCaptureAction = (intent: string, fields: Readonly<Record<string, string>>) => Promise<unknown>;
export type CountCaptureDeploymentCollection = (
  authority: CountCaptureAuthority,
  now: string,
) => Promise<CountCaptureAuthority["collection"]>;

// This driver has no confirm/import/retry capability. The server independently
// owns session admission, phase transitions, notices and possible-send debits.
export async function runCountCaptureJourney(
  identity: z.infer<typeof identitySchema>,
  action: CountCaptureAction,
  now = () => new Date().toISOString(),
  collectDeployment?: CountCaptureDeploymentCollection,
) {
  let phase: CountLifecycleStopReceipt["phase"] = "baseline";
  const stop = (reason: CountLifecycleStopReceipt["reason"]): CountLifecycleStopReceipt => ({
    schemaVersion: "scope-sync-count-lifecycle-stop/v1",
    stoppedAt: now(),
    phase,
    reason,
    evidence: {},
  });
  if (!identitySchema.safeParse(identity).success) return stop("authority-unbound");
  try {
    const baseline = baselineSchema.parse(await action("capture-baseline", identity));
    if (
      baseline.authority.runnerSha !== identity.sha ||
      baseline.authority.dispatchId !== identity.dispatchId ||
      baseline.selection.scopeRecordId !== identity.scopeRecordId ||
      baseline.plannerInput.selection.scopeRecordIds[0] !== identity.scopeRecordId ||
      new Set(baseline.units.map((unit) => unit.unitKey)).size !== 3 ||
      !validateCountCaptureAuthority(baseline.authority, now()) ||
      !baseline.effects.complete ||
      [
        baseline.effects.batches,
        baseline.effects.reservations,
        baseline.effects.jobs,
        baseline.effects.enqueues,
        baseline.effects.imports,
      ].some((value) => value !== 0)
    )
      return stop("authority-unbound");
    if (!collectDeployment) return stop("deployment-unknown");
    const collection = await collectDeployment(baseline.authority, now());
    if (!validateCountCaptureAuthority({ ...baseline.authority, collection }, now())) return stop("deployment-unknown");
    acknowledgementSchema.parse(await action("capture-initial-notice", {}));
    if (baseline.bootstrapRequired) {
      phase = "bootstrap";
      acknowledgementSchema.parse(await action("capture-usage", {}));
    }
    phase = "quote";
    const quote = quoteSchema.parse(await action("count-quote", {}));
    if (quote.serverCap !== quote.plannedCount) return stop("capture-stopped");
    const readBack = quoteSchema.parse(await action("capture-quote-readback", {}));
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
    const plannerFields = { captureInput: JSON.stringify(baseline.plannerInput) };
    const preview = z
      .object({ planFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(await action("preview", plannerFields));
    phase = "pre-confirm";
    const preConfirm = preConfirmSchema.parse(
      await action("pre-confirm-planner-read", { ...plannerFields, planFingerprint: preview.planFingerprint }),
    );
    if (
      preConfirm.comparedFingerprint !== preview.planFingerprint ||
      preConfirm.currentFingerprint !== preview.planFingerprint ||
      preConfirm.eligible !== (preConfirm.refusal === null)
    )
      return stop("missing-observation");
    phase = "freeze";
    const freezeCollection = await collectDeployment(baseline.authority, now());
    const receipt = await action("capture-freeze", { collection: JSON.stringify(freezeCollection) });
    const parsed = countLifecycleReceiptSchema.parse(receipt);
    if (
      parsed.authority.runnerSha !== identity.sha ||
      parsed.authority.dispatchId !== identity.dispatchId ||
      parsed.selection.scopeRecordId !== identity.scopeRecordId ||
      parsed.preConfirm.comparedFingerprint !== preConfirm.comparedFingerprint ||
      parsed.preConfirm.currentFingerprint !== preConfirm.currentFingerprint ||
      parsed.preConfirm.eligible !== preConfirm.eligible ||
      JSON.stringify(parsed.freezeCollection) !== JSON.stringify(freezeCollection) ||
      !validateCountLifecycleReceipt(receipt).valid
    )
      return stop("missing-observation");
    return parsed;
  } catch {
    // No follow-up action is safe after an uncertain send. Durable server
    // accounting remains authoritative; absent final evidence stays absent.
    return stop("capture-stopped");
  }
}
