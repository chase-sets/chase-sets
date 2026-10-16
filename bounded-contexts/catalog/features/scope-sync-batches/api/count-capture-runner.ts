import { z } from "zod";
import {
  countCaptureAuthoritySchema,
  countLifecycleReceiptSchema,
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
            baseline: z
              .object({
                batches: z.number(),
                reservations: z.number(),
                jobs: z.number(),
                enqueues: z.number(),
                imports: z.number(),
              })
              .optional(),
            final: z
              .object({
                batches: z.number(),
                reservations: z.number(),
                jobs: z.number(),
                enqueues: z.number(),
                imports: z.number(),
              })
              .optional(),
            complete: z.boolean().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    bootstrapRequired: z.boolean().optional(),
    providerEgressDenied: z.literal(true).optional(),
  })
  .passthrough();
const acknowledgementSchema = z.object({}).passthrough();

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
      baseline.baseline.effects.complete === false ||
      [
        baseline.baseline.effects.baseline?.batches,
        baseline.baseline.effects.baseline?.reservations,
        baseline.baseline.effects.baseline?.jobs,
        baseline.baseline.effects.baseline?.enqueues,
        baseline.baseline.effects.baseline?.imports,
      ].some((value) => value !== 0)
    )
      return stop("authority-unbound");
    if (!collectDeployment) return stop("deployment-unknown");
    const collection = await collectDeployment(baseline.authority, now());
    if ((collection as { complete?: boolean } | null)?.complete === false) return stop("deployment-unknown");
    if (!validateCountCaptureAuthority({ ...baseline.authority, collection }, now()).ok)
      return stop("deployment-unknown");
    acknowledgementSchema.parse(await action("capture-initial-notice", {}));
    if (baseline.bootstrapRequired) {
      phase = "bootstrap";
      acknowledgementSchema.parse(await action("capture-usage", {}));
    }
    phase = "quote";
    const quote = countQuoteSchema.parse(await action("count-quote", {}));
    if (quote.cap !== quote.plannedCredits) return stop("capture-stopped");
    const readBack = countQuoteSchema.parse(await action("capture-quote-readback", {}));
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
    const freezeCollection = await collectDeployment(baseline.authority, now());
    const frozen = await action("capture-freeze", { collection: JSON.stringify(freezeCollection) });
    const parsed = countLifecycleReceiptSchema.parse((frozen as { receipt?: unknown })?.receipt ?? frozen);
    if (
      parsed.authority.runnerSha !== identity.sha ||
      parsed.authority.dispatchId !== identity.dispatchId ||
      parsed.selection.scopeRecordId !== identity.scopeRecordId ||
      JSON.stringify(parsed.freezeCollection) !== JSON.stringify(freezeCollection) ||
      !validateCountLifecycleReceipt(parsed).valid
    )
      return stop("missing-observation");
    return parsed;
  } catch {
    // No follow-up action is safe after an uncertain send. Durable server
    // accounting remains authoritative; absent final evidence stays absent.
    return stop("capture-stopped");
  }
}
