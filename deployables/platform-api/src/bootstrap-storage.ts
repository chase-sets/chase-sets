import { createFilesystemObjectStorage, createS3ObjectStorage } from "@chase-sets/object-storage";

import type { PlatformApiBootstrapConfig } from "./config";

export function createPlatformBootstrapStoragePorts(
  config: Pick<PlatformApiBootstrapConfig, "catalogAssetStorage" | "listingPhotoStorage">,
) {
  return {
    catalogAssetStorage:
      config.catalogAssetStorage.kind === "s3"
        ? createS3ObjectStorage(config.catalogAssetStorage)
        : createFilesystemObjectStorage(config.catalogAssetStorage),
    listingPhotoStorage:
      config.listingPhotoStorage.kind === "s3"
        ? createS3ObjectStorage(config.listingPhotoStorage)
        : createFilesystemObjectStorage(config.listingPhotoStorage),
    returnIntakeEvidenceStorage:
      config.listingPhotoStorage.kind === "s3"
        ? createS3ObjectStorage({
            ...config.listingPhotoStorage,
            publicBaseUrl: "private://return-intake-evidence",
          })
        : createFilesystemObjectStorage({
            rootDir: `${config.listingPhotoStorage.rootDir}/private-return-intake`,
            publicBaseUrl: "private://return-intake-evidence",
          }),
    supportEvidenceAttachmentStorage:
      config.listingPhotoStorage.kind === "s3"
        ? createS3ObjectStorage({
            ...config.listingPhotoStorage,
            publicBaseUrl: "private://support-evidence",
          })
        : createFilesystemObjectStorage({
            rootDir: `${config.listingPhotoStorage.rootDir}-private-support-evidence`,
            publicBaseUrl: "private://support-evidence",
          }),
  };
}
