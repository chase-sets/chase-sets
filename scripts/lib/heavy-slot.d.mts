export interface HeavySlotVitestProject {
  readonly vitest?: Readonly<{
    filenamePattern?: readonly string[];
  }>;
  readonly config?: Readonly<{
    root?: string;
    watch?: boolean;
  }>;
}

export interface HeavySlotAcquisitionOptions {
  readonly startDirectory?: string;
}

export function findHeavySlotClient(startDirectory?: string): string | null;

export function acquireHeavySlot(kind: string, options?: HeavySlotAcquisitionOptions): boolean;

export function isFocusedVitestFileRun(project: HeavySlotVitestProject): boolean;

export function isDatabaseVitestRun(env?: Readonly<Record<string, string | undefined>>): boolean;

export function acquireVitestHeavySlot(
  project: HeavySlotVitestProject,
  kind?: string,
  options?: HeavySlotAcquisitionOptions & {
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): boolean;

export const heavySlotVitestGlobalSetupPath: string;

export default function setupHeavySlot(project: HeavySlotVitestProject): void;
