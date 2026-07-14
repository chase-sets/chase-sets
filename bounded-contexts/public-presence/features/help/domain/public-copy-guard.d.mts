export type PublicCopyCorpus = "consumer" | "developer";
export type PublicCopyGuard = "launch-language" | "agent-commerce";

export function findPublicCopyViolations(
  input: Readonly<{
    corpus: PublicCopyCorpus;
    copy: string;
    guard: PublicCopyGuard;
  }>,
): readonly string[];

export function assertPublicCopyGuard(
  input: Readonly<{
    corpus: PublicCopyCorpus;
    copy: string;
    guard: PublicCopyGuard;
  }>,
): void;
