import type { Projector } from "./projector";

export function startProjectorPolling(
  projectors: readonly Projector[],
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  const intervalHandle = setInterval(async () => {
    for (const projector of projectors) {
      try {
        await projector.runOnce();
      } catch (error) {
        onError(error);
      }
    }
  }, intervalMs);

  return () => clearInterval(intervalHandle);
}
