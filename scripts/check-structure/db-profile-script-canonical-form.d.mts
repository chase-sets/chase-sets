export interface TestSelectionConfig {
  readonly kind: "base" | "db" | "unit";
  readonly configPath: string;
  readonly baseConfigPath?: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly globalSetup: readonly string[];
  readonly maxWorkers?: number;
}

export interface ConfigTestInventory {
  readonly config: TestSelectionConfig;
  readonly files: readonly string[];
}

export interface DbProfileInventory {
  readonly files: readonly string[];
  readonly aggregate: ConfigTestInventory;
  readonly units: readonly (ConfigTestInventory & { readonly name: string })[];
  readonly unit: ConfigTestInventory;
  readonly violations: readonly string[];
}

export interface DbProfileWorkspace {
  readonly name: string;
  readonly dir: string;
  readonly packageJson: {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly chaseSets?: { readonly testProfile?: string };
  };
}

export function dbProfileConfigPath(scriptName: string): string;
export function canonicalDbProfileCommand(scriptName: string): string;
export function readTestSelectionConfig(
  configPath: string,
  active?: Set<string>,
  cache?: Map<string, TestSelectionConfig>,
): TestSelectionConfig;
export function listTestFiles(workspaceRoot: string): string[];
export function discoverConfigTests(
  workspaceRoot: string,
  configPath: string,
  files?: readonly string[],
  cache?: Map<string, TestSelectionConfig>,
): ConfigTestInventory;
export function discoverDbProfile(workspaceRoot: string, unitNames?: readonly string[]): DbProfileInventory;
export function validateDbProfileScripts(workspace: DbProfileWorkspace): {
  readonly violations: readonly string[];
  readonly inventory: DbProfileInventory | null;
};
export function validateDbProfiles(options?: {
  readonly repoRoot?: string;
  readonly workspaces?: readonly DbProfileWorkspace[];
}): {
  readonly violations: readonly string[];
  readonly inventory: readonly (DbProfileInventory & { readonly workspace: string })[];
  readonly scanned: number;
  readonly total: number;
};
