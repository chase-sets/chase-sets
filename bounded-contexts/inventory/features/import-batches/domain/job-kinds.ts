export const INVENTORY_IMPORT_CREATE_JOB_KINDS = ["create", "create-snapshot-v1"] as const;

export const INVENTORY_IMPORT_LEGACY_JOB_KIND = INVENTORY_IMPORT_CREATE_JOB_KINDS[0];
export const INVENTORY_IMPORT_SNAPSHOT_JOB_KIND = INVENTORY_IMPORT_CREATE_JOB_KINDS[1];
export const INVENTORY_IMPORT_COMMIT_JOB_KIND = "commit" as const;

export function isInventoryImportCreateJobKind(jobKind: string): boolean {
  return (INVENTORY_IMPORT_CREATE_JOB_KINDS as readonly string[]).includes(jobKind);
}
