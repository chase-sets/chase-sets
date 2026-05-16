# Catalog Asset Storage

Catalog uses owned asset storage for provider-fed product imagery. TCGdex imports mirror only the high quality `high.webp` card image into Chase Sets storage before recording a Source Observation. Promoted Catalog Items receive Chase Sets-owned image URLs, not TCGdex asset URLs.

## Local Development

Local development uses filesystem-backed storage by default:

```bash
CATALOG_ASSET_STORAGE_KIND=filesystem
CATALOG_ASSET_LOCAL_ROOT=../../artifacts/catalog-assets/admin-support-api
CATALOG_ASSET_PUBLIC_BASE_URL=http://localhost:6192/catalog-assets
```

`CATALOG_ASSET_PUBLIC_BASE_URL` may point at either `admin-support-api` or `platform-api` as long as that deployable is serving the same local storage root. If it is omitted, the API uses its configured `PORT` and `/catalog-assets`.

## Shared Environments

Shared environments should use DigitalOcean Spaces through the S3-compatible adapter:

```bash
CATALOG_ASSET_STORAGE_KIND=s3
CATALOG_ASSET_S3_BUCKET=chase-sets-catalog-assets
CATALOG_ASSET_S3_REGION=nyc3
CATALOG_ASSET_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
CATALOG_ASSET_PUBLIC_BASE_URL=https://assets.chasesets.com
CATALOG_ASSET_S3_ACCESS_KEY_ID=...
CATALOG_ASSET_S3_SECRET_ACCESS_KEY=...
```

Production rejects filesystem-backed Catalog asset storage. Keep bucket permissions, CDN policy, and lifecycle rules outside Catalog; Catalog owns only the provider import decision and the public URL it stores.

## Failure Policy

- If TCGdex does not provide an image, the observation records no image URLs.
- If TCGdex provides an image but download or storage fails, the observation fails and should be retried.
- Re-imports use deterministic object keys under `catalog/source-observations/tcgdex/{languageCode}/{externalKey}/high.webp`.
