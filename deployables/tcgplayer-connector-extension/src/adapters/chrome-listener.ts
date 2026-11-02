// Chrome ignores a listener's return value, so a rejected background listener is
// reported to the worker's global error handling instead of being left unhandled.
export function chromeListener<Args extends unknown[]>(
  listener: (...args: Args) => Promise<void>,
): (...args: Args) => void {
  return (...args) => {
    listener(...args).catch((error: unknown) => reportError(error));
  };
}
