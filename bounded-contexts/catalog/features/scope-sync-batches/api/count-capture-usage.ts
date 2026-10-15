import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import type { CountAuthority } from "../domain/count-acquisition";

// Skips the usage read when durable count authority already covers `required`;
// otherwise makes exactly one deployed adapter usage observation, whose own
// callback persists the sanitized snapshot. Only the durable authority read back
// afterwards decides: the raw returned balance is never authority.
export async function retainTargetedCountCaptureUsage(
  deps: Readonly<{ authority(): Promise<CountAuthority>; getUsageSnapshot(): Promise<unknown> }>,
  required: number,
) {
  const covers = (authority: CountAuthority) =>
    authority.allowed && authority.headroom !== null && authority.headroom >= required;
  const before = await deps.authority();
  if (covers(before)) return { state: "skipped" as const, required, authority: before };
  await deps.getUsageSnapshot();
  const after = await deps.authority();
  if (!covers(after)) throw new CountCaptureStopped();
  return { state: "persisted" as const, required, authority: after };
}
