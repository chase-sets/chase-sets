export declare function dryRun(input: unknown): Promise<{
  manifest: Record<string, unknown>;
  receipt: { result: string };
}>;
