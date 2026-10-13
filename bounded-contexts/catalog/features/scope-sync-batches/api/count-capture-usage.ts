import type { CountAuthority } from "../domain/count-acquisition";
import { CountCaptureStopped } from "./count-capture-context";

export async function retainTargetedCountCaptureUsage(
  deps: {
    authority(): Promise<CountAuthority>;
    getUsageSnapshot(): Promise<unknown>;
  },
  remainingRunCap: number,
) {
  if (!Number.isSafeInteger(remainingRunCap) || remainingRunCap < 1 || remainingRunCap > 11)
    throw new CountCaptureStopped();
  const sufficient = (authority: CountAuthority) =>
    authority.allowed && authority.headroom !== null && authority.headroom >= remainingRunCap;
  if (sufficient(await deps.authority())) return { state: "skipped" as const };
  // The adapter owns sanitation and invokes onUsageObserved. A raw returned
  // balance cannot substitute for the callback's durable count authority.
  await deps.getUsageSnapshot();
  if (!sufficient(await deps.authority())) throw new CountCaptureStopped();
  return { state: "persisted" as const };
}
