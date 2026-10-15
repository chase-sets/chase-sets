export function createBrowserProofResources() {
  const releases: Array<() => Promise<void>> = [];
  let beforeDispose: (() => Promise<void>) | undefined;
  let disposal: Promise<void> | undefined;
  return {
    release(release: () => Promise<void>) {
      if (disposal) throw new Error("Invitation proof resources are already disposing");
      releases.push(release);
    },
    beforeDispose(cleanup: () => Promise<void>) {
      if (disposal || beforeDispose) throw new Error("Invitation proof cleanup already registered or started");
      beforeDispose = cleanup;
    },
    dispose() {
      disposal ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        try {
          await beforeDispose?.();
        } catch (error) {
          errors.push(error);
        }
        const results = await Promise.allSettled(
          [...releases].reverse().map((release) => Promise.resolve().then(release)),
        );
        for (const result of results) if (result.status === "rejected") errors.push(result.reason);
        if (errors.length) throw new AggregateError(errors, "Invitation proof cleanup failed");
      });
      return disposal;
    },
  };
}

export async function runBrowserProof(
  proof: (resources: ReturnType<typeof createBrowserProofResources>) => Promise<void>,
) {
  const resources = createBrowserProofResources();
  const errors: unknown[] = [];
  try {
    await proof(resources);
  } catch (error) {
    errors.push(error);
  }
  try {
    await resources.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Invitation proof and cleanup failed");
}
