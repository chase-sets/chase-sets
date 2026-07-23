export function runVerifyObservationPackCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  output: Readonly<{ write(value: string): unknown }>,
  dependencies?: Readonly<{
    fetch?: typeof globalThis.fetch;
    verifyPostReplay?: (input: unknown) => Promise<unknown>;
  }>,
): Promise<number>;

export function verifyPostReplay(input: Readonly<Record<string, unknown>>): Promise<unknown>;

export function buildPostReplayVerifierEvidence(
  input: Readonly<{
    externalReferenceDigest: string;
    counts: Readonly<Record<string, number>>;
    perTableRowCounts: readonly Readonly<{ table: string; rowCount: string }>[];
  }>,
): Readonly<{
  verifierDigest: string;
  externalReferenceDigest: string;
  counts: Readonly<Record<string, number>>;
  perTableRowCounts: readonly Readonly<{ table: string; rowCount: string }>[];
}>;
