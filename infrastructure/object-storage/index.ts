import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export type ObjectStoragePutInput = Readonly<{
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
  visibility?: "public" | "private";
}>;

export type ObjectStoragePutResult = Readonly<{
  key: string;
  publicUrl: string;
}>;

export type ObjectStorage = Readonly<{
  putObject(input: ObjectStoragePutInput): Promise<ObjectStoragePutResult>;
  getObject(key: string): Promise<FilesystemObject | null>;
  deleteObjects(keys: readonly string[]): Promise<void>;
}>;

export type FilesystemObjectStorageOptions = Readonly<{
  rootDir: string;
  publicBaseUrl: string;
}>;

export type S3ObjectStorageOptions = Readonly<{
  bucket: string;
  region: string;
  publicBaseUrl: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  client?: Pick<S3Client, "send">;
  clientConfig?: Omit<S3ClientConfig, "region" | "endpoint" | "credentials" | "forcePathStyle">;
}>;

export type FilesystemObject = Readonly<{
  body: Uint8Array;
  contentType: string;
}>;

export function createFilesystemObjectStorage(options: FilesystemObjectStorageOptions): ObjectStorage {
  const rootDir = path.resolve(options.rootDir);

  return {
    async putObject(input) {
      const safeKey = normalizeObjectKey(input.key);
      const targetPath = resolveObjectPath(rootDir, safeKey);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, input.body);

      return {
        key: safeKey,
        publicUrl: joinPublicUrl(options.publicBaseUrl, safeKey),
      };
    },
    async getObject(key) {
      return readFilesystemObject(rootDir, key);
    },
    async deleteObjects(keys) {
      const { rm } = await import("node:fs/promises");
      await Promise.all(keys.map((key) => rm(resolveObjectPath(rootDir, normalizeObjectKey(key)), { force: true })));
    },
  };
}

export function createS3ObjectStorage(options: S3ObjectStorageOptions): ObjectStorage {
  const client =
    options.client ??
    new S3Client({
      ...options.clientConfig,
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    });

  return {
    async putObject(input) {
      const safeKey = normalizeObjectKey(input.key);
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: safeKey,
          Body: input.body,
          ...(input.visibility === "private" ? {} : { ACL: "public-read" as const }),
          ContentType: input.contentType,
          CacheControl: input.cacheControl,
        }),
      );

      return {
        key: safeKey,
        publicUrl: joinPublicUrl(options.publicBaseUrl, safeKey),
      };
    },
    async getObject(key) {
      const safeKey = normalizeObjectKey(key);
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: safeKey }));
        if (!response.Body) {
          return null;
        }
        return {
          body: new Uint8Array(await response.Body.transformToByteArray()),
          contentType: response.ContentType ?? contentTypeFromKey(safeKey),
        };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) {
          return null;
        }
        throw error;
      }
    },
    async deleteObjects(keys) {
      if (keys.length === 0) {
        return;
      }
      await client.send(
        new DeleteObjectsCommand({
          Bucket: options.bucket,
          Delete: { Objects: keys.map((key) => ({ Key: normalizeObjectKey(key) })), Quiet: true },
        }),
      );
    },
  };
}

export async function readFilesystemObject(rootDir: string, key: string): Promise<FilesystemObject | null> {
  const safeKey = normalizeObjectKey(key);
  const filePath = resolveObjectPath(path.resolve(rootDir), safeKey);

  try {
    return {
      body: await readFile(filePath),
      contentType: contentTypeFromKey(safeKey),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function normalizeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith(".") ||
    normalized.includes("../") ||
    normalized.includes("/..")
  ) {
    throw new Error("Object storage keys must be relative paths without traversal.");
  }

  return normalized;
}

function resolveObjectPath(rootDir: string, key: string): string {
  const resolved = path.resolve(rootDir, key);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Object storage key resolves outside the storage root.");
  }

  return resolved;
}

function joinPublicUrl(publicBaseUrl: string, key: string): string {
  const base = publicBaseUrl.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${base}/${encodedKey}`;
}

function contentTypeFromKey(key: string): string {
  if (key.endsWith(".webp")) {
    return "image/webp";
  }
  if (key.endsWith(".png")) {
    return "image/png";
  }
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}
