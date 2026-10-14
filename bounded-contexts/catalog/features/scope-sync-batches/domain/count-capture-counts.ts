import { z } from "zod";
import { countCapturePlannerInputSchema } from "./count-capture-plan";

export const countCaptureQuoteSchema = z
  .object({
    quoteId: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    plannedCount: z.number().int().min(0).max(2),
    serverCap: z.number().int().min(0).max(2),
  })
  .strict();

export const countCaptureAcquisitionInputSchema = countCapturePlannerInputSchema.extend({
  quoteId: countCaptureQuoteSchema.shape.quoteId,
  fingerprint: countCaptureQuoteSchema.shape.fingerprint,
});
