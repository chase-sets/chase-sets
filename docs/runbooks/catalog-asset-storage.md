# Catalog Asset Storage

Catalog uses owned asset storage for provider-fed product imagery. TCGdex imports download the high quality `high.webp` card image as the source asset, generate normalized WebP variants, and record a Product Asset Set before recording a Source Observation. Promoted Catalog Items receive Chase Sets-owned Product Asset Sets plus compatibility image URLs, not TCGdex asset URLs.

## Variant Policy

Catalog stores browser delivery variants by pixel dimensions and device-pixel-ratio targets. Embedded DPI/PPI metadata is not used for web delivery decisions.

| Role | Widths | Use |
| --- | ---: | --- |
| `thumbnail` | 96w, 192w | compact card thumbnails, cart line item art, admin rows |
| `search-card` | 160w, 320w | search and catalog cards |
| `catalog-detail` | 480w, 960w | item detail and admin review previews |
| `source` | natural | provenance and future regeneration |

All generated files are stored as `image/webp`, preserve aspect ratio, and should be served with long-lived immutable cache headers.

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

## Object Keys

TCGdex normalized assets use deterministic keys under:

```text
catalog/source-observations/tcgdex/{languageCode}/{externalKey}/{role}-{width}w-{density}x-{sourceHash12}.webp
```

The source asset uses:

```text
catalog/source-observations/tcgdex/{languageCode}/{externalKey}/source-{sourceHash12}.webp
```

The source hash keeps replay/idempotency stable while allowing a future provider image change to produce new object keys for review.

## Failure Policy

- If TCGdex does not provide an image, the observation records no image URLs.
- If TCGdex provides an image but download, processing, or storage fails, the observation fails and should be retried.
- Re-imports of the same source image use the same deterministic object keys.
- Discovery and downstream contexts should continue using the previously projected Product Asset Set until a new Catalog asset event projects successfully.
