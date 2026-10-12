import {
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  createFilesystemPrivateObjectStore,
  createS3PrivateObjectStore,
  type S3ObjectStorageOptions,
} from "@chase-sets/object-storage";
import { S3Client } from "@aws-sdk/client-s3";
import {
  openSupportEvidenceCanonicalizer,
  createSupportEvidenceCanonicalizationQueue,
} from "@chase-sets/platform-operations/server";

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
    supportEvidenceAttachmentStorage: createSupportEvidenceAttachmentStorage(config.listingPhotoStorage),
  };
}

export function createSupportEvidenceAttachmentStorage(config: PlatformApiBootstrapConfig["listingPhotoStorage"]) {
  if (config.kind === "filesystem")
    return createFilesystemPrivateObjectStore({ rootDir: `${config.rootDir}-private-support-evidence` });
  return createS3PrivateObjectStore({ bucket: config.bucket, client: privateStoreClient(config) });
}

function privateStoreClient(config: S3ObjectStorageOptions) {
  return (
    config.client ??
    new S3Client({
      ...config.clientConfig,
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      ...(config.accessKeyId && config.secretAccessKey
        ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
        : {}),
    })
  );
}

export async function openPlatformSupportEvidenceCanonicalizer(productionLike: boolean) {
  return createSupportEvidenceCanonicalizationQueue(await openSupportEvidenceCanonicalizer({ productionLike }));
}
