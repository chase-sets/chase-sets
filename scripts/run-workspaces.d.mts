type Workspace = Readonly<{
  name: string;
  packageJson: Readonly<{
    scripts?: Readonly<Record<string, string>>;
    chaseSets?: Readonly<{ testProfile?: string }>;
  }>;
}>;

export const DB_TEST_SCRIPT_SELECTOR: "test:db*";

export function runWorkspaceScripts(
  options: Readonly<{
    argv: readonly string[];
    run?: (
      command: string,
      args: readonly string[],
      options: Readonly<{ prefix?: string; stdio?: "inherit"; timeoutMs?: number }>,
    ) => Promise<void>;
    loadEnvironment?: (options: Readonly<{ includeTestDatabaseUrl: boolean }>) => void;
    appendSummary?: (path: string, contents: string, encoding: "utf8") => void;
    listWorkspaces?: () => readonly Workspace[];
    durationHintRegistry?: Readonly<{
      schemaVersion: "workspace-test-duration-hints/v1";
      entries: readonly Readonly<{
        workspace: string;
        script: string;
        estimatedDurationSeconds: number;
      }>[];
    }>;
  }>,
): Promise<void>;
