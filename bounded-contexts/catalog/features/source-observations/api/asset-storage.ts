export type CatalogAssetStoragePutInput = Readonly<{
  key: string;
  body: Uint8Array;
  contentType: string;
  cacheControl?: string;
}>;

export type CatalogAssetStoragePutResult = Readonly<{
  key: string;
  publicUrl: string;
}>;

export type CatalogAssetStorage = Readonly<{
  putObject(input: CatalogAssetStoragePutInput): Promise<CatalogAssetStoragePutResult>;
}>;
