/**
 * Complete Git listings are buffered synchronously by the script checks.
 * Keep one measured capacity for every listing executor so a growing index or
 * tree cannot fall through Node's 1 MiB default. The current maximum measured
 * listing is 1,074,383 bytes, leaving 7,314,225 bytes of headroom.
 */
export const GIT_LISTING_MAX_BUFFER = 8 * 1024 * 1024;

export function gitListingOptions(options = {}) {
  return { ...options, maxBuffer: GIT_LISTING_MAX_BUFFER };
}
