export function runVerifyObservationPackCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: Readonly<{ write(value: string): unknown }>,
  dependencies?: Readonly<{
    fetch?: typeof globalThis.fetch;
    verifyPostReplay?: (input: unknown) => Promise<unknown>;
  }>,
): Promise<number>;
