// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  cacheSearchLoaderData,
  readCachedSearchLoaderData,
  searchLoaderCacheKey,
  SEARCH_LOADER_CACHE_TTL_MS,
} from "./search-loader-cache";

describe("search loader cache", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("collapses absolute and relative URLs for the same Result Set to one key", () => {
    expect(searchLoaderCacheKey("http://localhost/search?q=charizard")).toBe("/search?q=charizard");
    expect(searchLoaderCacheKey("/search?q=charizard")).toBe("/search?q=charizard");
  });

  it("restores a cached payload for the matching URL within the freshness window", () => {
    const payload = { data: { count: 24 }, canonicalUrl: "http://localhost/search?q=charizard" };
    const key = searchLoaderCacheKey("/search?q=charizard");

    cacheSearchLoaderData(window.sessionStorage, key, payload, 1_000);

    expect(readCachedSearchLoaderData(window.sessionStorage, key, 1_500)).toEqual(payload);
    expect(
      readCachedSearchLoaderData(window.sessionStorage, searchLoaderCacheKey("/search?q=pikachu"), 1_500),
    ).toBeNull();
  });

  it("expires entries once past the freshness window so a stale Result Set forces a fresh load", () => {
    const key = searchLoaderCacheKey("/search?q=charizard");
    cacheSearchLoaderData(window.sessionStorage, key, { data: {}, canonicalUrl: "x" }, 1_000);

    expect(readCachedSearchLoaderData(window.sessionStorage, key, 1_000 + SEARCH_LOADER_CACHE_TTL_MS)).not.toBeNull();
    expect(readCachedSearchLoaderData(window.sessionStorage, key, 1_001 + SEARCH_LOADER_CACHE_TTL_MS)).toBeNull();
  });

  it("keeps the newest entry and bounds the cache so a long session cannot grow without limit", () => {
    for (let index = 0; index < 12; index += 1) {
      cacheSearchLoaderData(
        window.sessionStorage,
        `/search?q=term-${index}`,
        { data: index, canonicalUrl: "x" },
        index,
      );
    }

    // The most recent writes survive; the oldest were evicted by the entry cap.
    expect(readCachedSearchLoaderData(window.sessionStorage, "/search?q=term-11", 11)).toEqual({
      data: 11,
      canonicalUrl: "x",
    });
    expect(readCachedSearchLoaderData(window.sessionStorage, "/search?q=term-0", 11)).toBeNull();
  });

  it("overwrites the entry for a URL rather than duplicating it", () => {
    const key = searchLoaderCacheKey("/search?q=charizard");
    cacheSearchLoaderData(window.sessionStorage, key, { data: "old", canonicalUrl: "x" }, 1_000);
    cacheSearchLoaderData(window.sessionStorage, key, { data: "new", canonicalUrl: "x" }, 2_000);

    expect(readCachedSearchLoaderData(window.sessionStorage, key, 2_100)).toEqual({ data: "new", canonicalUrl: "x" });
  });

  it("degrades to a fresh load when session storage is unavailable", () => {
    expect(readCachedSearchLoaderData(null, "/search?q=charizard")).toBeNull();
    expect(() => cacheSearchLoaderData(null, "/search?q=charizard", { data: {} })).not.toThrow();
  });
});
