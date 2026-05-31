import {
  buildReleaseControlsSnapshot,
  readReleaseControlsQuery,
  type ReleaseControlsSnapshot,
} from "../read-model/contracts";

export function loadReleaseControlsSnapshot(
  request: Request,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseControlsSnapshot {
  return buildReleaseControlsSnapshot(readReleaseControlsQuery(request), env);
}
