import { z } from "zod";

export const reviewAttemptResultSchema = z.strictObject({
  reviewId: z.string().min(1),
  version: z.number().int().positive().safe(),
});

export const reviewReplyAttemptResultSchema = reviewAttemptResultSchema.extend({ replyId: z.string().min(1) });
