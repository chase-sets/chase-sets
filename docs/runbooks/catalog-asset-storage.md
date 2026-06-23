# Catalog Asset Storage

Catalog uses owned asset storage for approved provider-fed product imagery. TCGdex imports download the high quality `high.webp` card image as the source asset, generate normalized WebP variants, and record a Product Asset Set before recording a Source Observation. Promoted Catalog Items receive Chase Sets-owned Product Asset Sets plus compatibility image URLs, not provider asset URLs.

One Piece image evidence is conservative by default:

| Source | Link as URI evidence | Rehost | Retain provider body or image bytes as evidence |
| --- | --- | --- | --- |
| Scrydex One Piece | Yes, when the approved API response contains an image URI and the provider-data signoff permits image evidence | Yes, only after Catalog downloads the image into a Product Asset Set | No |
| TCGplayer One Piece | Yes, when the approved provider path returns product image URI evidence | Yes, only after Catalog downloads the image into a Product Asset Set | No |
| Bandai official One Piece Card Game | Validation label only | No, unless a separate legal/source approval changes the source role | No |
| Fallback, community, or comparison sources | No by default | No | No |

Approved One Piece image URI evidence is retained as redacted audit evidence. The Product Asset Set stores the source provider key, source URL host, source URL hash, source content type, rehosting behavior, and the `catalog-product-image-retention-v1` policy. It does not store the full provider image URL inside the retained asset metadata.

## Variant Policy

Catalog stores browser delivery variants by pixel dimensions and device-pixel-ratio targets. Embedded DPI/PPI metadata is not used for web delivery decisions.

Each role's width is also a rendering contract. Product UI should render the role at its listed CSS slot and pass the matching `srcset`/`sizes` metadata so the browser can select a source whose intrinsic width is at least the rendered slot multiplied by device pixel ratio. Do not stretch a role beyond its CSS slot to fill a larger frame; use a larger role or add a new role when the design intentionally needs a larger rendered image.

| Role | Widths | Use |
| --- | ---: | --- |
| `thumbnail` | 96w, 192w | compact card thumbnails, cart line item art, admin rows |
| `search-card` | 160w, 320w | search and catalog cards |
| `catalog-detail` | 480w, 960w | item detail and admin review previews |
| `source` | natural | provenance and future regeneration |

All generated files are stored as `image/webp`, preserve aspect ratio, preserve alpha, and should be served with long-lived immutable cache headers. Display variants are generated from a normalized display source that trims transparent or near-empty edge padding before resizing. The original provider asset remains stored as the `source` variant for provenance and future regeneration.

Display variant object keys include both the source hash and the display-normalization fingerprint. When the normalization policy changes, new variant URLs are generated instead of overwriting immutable CDN objects with different bytes.

## Retention And Removal

Production and staging Product Asset Sets are retained while referenced by a Source Observation, Catalog Item, or downstream projection. Preview assets expire after 90 days through the preview bucket lifecycle rule. Staging and production do not expire automatically because product imagery is catalog truth once promoted.

Takedown, source revocation, or policy/legal removal requests use the Catalog asset takedown path:

1. Freeze new imports or promotions for the affected provider/unit if the source approval is in doubt.
2. Locate Product Asset Sets by source provider key, source URL hash or host, source hash, storage key, public URL, Catalog Item id, or Source Observation id.
3. Remove the Catalog Item image URLs and Product Asset Sets through Catalog commands so projections drop the public references.
4. Delete the source and generated variant objects from the environment bucket/CDN origin.
5. Record redacted audit evidence with the source provider key, Catalog-owned storage keys or hashes, actor, reason, and removal timestamp.

The target removal SLA is 30 days after an approved takedown/removal request, or sooner when legal/security requires it. Do not retain provider image bytes, screenshots, raw payload bodies, cookies, seller/account facts, prices, inventory, quantities, listings, or provider console captures in issue comments, fixtures, logs, metrics, traces, PR bodies, or UAT evidence.

## Local Development

Local development uses filesystem-backed storage by default:

```bash
CATALOG_ASSET_STORAGE_KIND=filesystem
CATALOG_ASSET_LOCAL_ROOT=../../artifacts/catalog-assets/admin-support-api
CATALOG_ASSET_PUBLIC_BASE_URL=http://localhost:6192/catalog-assets
```

`CATALOG_ASSET_PUBLIC_BASE_URL` may point at either `admin-support-api` or `platform-api` as long as that deployable is serving the same local storage root. If it is omitted, the API uses its configured `PORT` and `/catalog-assets`.

## Shared Environments

Preview, staging, and production use separate DigitalOcean Spaces buckets with Standard Storage and CDN-backed custom domains:

| Environment | Bucket | Public base URL |
| --- | --- | --- |
| `preview` | `chase-sets-preview-catalog-assets` | `https://assets.preview.chasesets.com` |
| `staging` | `chase-sets-staging-catalog-assets` | `https://assets.staging.chasesets.com` |
| `production` | `chase-sets-production-catalog-assets` | `https://assets.chasesets.com` |

PR previews share the preview bucket and CDN domain. The PR-specific platform Terraform states consume that shared asset storage and must not own it directly.

Shared environments use DigitalOcean Spaces through the S3-compatible adapter:

```bash
CATALOG_ASSET_STORAGE_KIND=s3
CATALOG_ASSET_S3_BUCKET=chase-sets-production-catalog-assets
CATALOG_ASSET_S3_REGION=nyc3
CATALOG_ASSET_S3_ENDPOINT=https://nyc3.digitaloceanspaces.com
CATALOG_ASSET_PUBLIC_BASE_URL=https://assets.chasesets.com
CATALOG_ASSET_S3_ACCESS_KEY_ID=...
CATALOG_ASSET_S3_SECRET_ACCESS_KEY=...
```

Production rejects filesystem-backed Catalog asset storage. The `infrastructure/digitalocean/catalog-assets` Terraform root owns bucket permissions, CDN policy, managed certificates, and CDN custom domains. The staging CDN DNS record is also declared in `infrastructure/digitalocean/environment-dns` because `assets.staging.chasesets.com` lives inside the delegated `staging.chasesets.com` child zone. Catalog owns only the provider import decision and the public URL it stores.

The CDN custom domain is required, not cosmetic. If an asset URL works through the direct Spaces origin but fails through `assets.<environment>.chasesets.com`, verify that `doctl compute cdn list` contains the environment custom domain and that DigitalOcean DNS has a CNAME from that custom domain to the CDN endpoint. Staging reset verifies both after recreating catalog assets, and platform staging/production smoke checks verify the configured `CATALOG_ASSET_PUBLIC_BASE_URL` over HTTPS.

## Object Keys

Provider-normalized assets use deterministic keys under:

```text
catalog/source-observations/{providerKey}/{languageCode}/{externalKey}/{role}-{width}w-{density}x-{sourceHash12}.webp
```

The source asset uses:

```text
catalog/source-observations/{providerKey}/{languageCode}/{externalKey}/source-{sourceHash12}.webp
```

The source hash keeps replay/idempotency stable while allowing a future provider image change to produce new object keys for review.

## Failure Policy

- If an approved provider does not provide an image, the observation records no image URLs.
- If an approved provider provides an image but download, processing, or storage fails, the observation fails and should be retried.
- Re-imports of the same source image use the same deterministic object keys.
- Discovery and downstream contexts should continue using the previously projected Product Asset Set until a new Catalog asset event projects successfully.
- Preview assets expire after 90 days through the preview bucket lifecycle rule. Staging and production assets do not expire automatically.
