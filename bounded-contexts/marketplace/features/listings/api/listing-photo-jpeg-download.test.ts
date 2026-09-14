import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createFilesystemObjectStorage } from "@chase-sets/object-storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { buildMarketplaceApi, type MarketplaceApiEnv } from "../../../api";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { hydrateStoredListingPhoto, initialMarketplaceListingState } from "../domain/domain";
import { createMarketplaceListingRuntime } from "./runtime";

// All actors, streams and image bytes here are synthetic; no provider upload is claimed.
const owner = createId("acc");
const foreign = createId("acc");
const listingId = createId("lst");
const photoId = createId("lpho");
const sourceKey = `synthetic/${listingId}/${photoId}/source.webp`;
const route = `/api/marketplace/account/listings/${listingId}/photos/${photoId}/jpeg`;
const roots: string[] = [];
const actor = {
  sessionId: "synthetic-session",
  tenantId: createId("tnt"),
  userId: createId("usr"),
  accountId: owner,
  membershipId: "synthetic-membership",
  roleKey: "seller",
  permissions: ["listings.view"],
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function alphaSource(width = 1200, height = 800) {
  const body = Buffer.alloc(width * height * 4);
  let state = 0x7766;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        body[offset + channel] = state & 255;
      }
      body[offset + 3] = x < 64 && y < 64 ? 0 : x < 128 ? 128 : 255;
    }
  }
  return sharp(body, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true })
    .toBuffer();
}

async function fixture(resolveRateLimitRule?: RateLimitRuleResolver, source?: Buffer, noStorage = false) {
  const artifactRoot = join(process.cwd(), "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const root = await mkdtemp(join(artifactRoot, "jpeg-test-"));
  roots.push(root);
  const storage = createFilesystemObjectStorage({ rootDir: root, publicBaseUrl: "https://synthetic.invalid" });
  const sourceBody = source ?? (await alphaSource());
  await storage.putObject({ key: sourceKey, body: sourceBody, contentType: "image/webp" });
  const sourceMetadata = await sharp(sourceBody)
    .metadata()
    .catch(() => ({ width: 1200, height: 800 }));
  const photo = hydrateStoredListingPhoto({
    photoId,
    sortOrder: 0,
    uploadedAt: "2026-09-12T00:00:00.000Z",
    assetSet: {
      kind: "listing-photo",
      sourceHash: createHash("sha256").update(sourceBody).digest("hex"),
      source: {
        role: "source",
        width: sourceMetadata.width!,
        height: sourceMetadata.height!,
        density: null,
        mediaType: "image/webp",
        storageKey: sourceKey,
        publicUrl: "https://synthetic.invalid/source.webp",
        byteSize: sourceBody.length,
        generatedAt: "2026-09-12T00:00:00.000Z",
      },
      variants: [
        {
          role: "catalog-detail",
          width: 960,
          height: 640,
          density: 2,
          mediaType: "image/webp",
          storageKey: "synthetic/display-must-not-be-read.webp",
          publicUrl: "https://synthetic.invalid/display.webp",
          byteSize: 100,
          generatedAt: "2026-09-12T00:00:00.000Z",
        },
      ],
    },
  });
  const { eventStore } = createInMemoryEventStore();
  const context = { tenantId: actor.tenantId, audit: { performedByUserId: actor.userId, forAccountId: owner } };
  await eventStore.appendToStream({
    streamId: `marketplace.listing-${listingId}`,
    expectedVersion: "no_stream",
    context,
    events: [
      {
        eventType: "marketplace.listing.created",
        payload: {
          ...initialMarketplaceListingState,
          listingId,
          accountId: owner,
          evidence: [photo],
        },
      },
    ],
  });
  const readObject = vi.spyOn(storage, "getObject");
  const putObject = vi.spyOn(storage, "putObject");
  const readStream = vi.spyOn(eventStore, "readStream");
  const db = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: async () => {
      throw new Error("Unexpected transaction");
    },
  };
  const services = createMarketplaceServices(db, { rateLimitPolicyResolver: resolveRateLimitRule });
  const listings = createMarketplaceListingRuntime({
    db,
    eventStore,
    commercialTermsResolver: services.commercialTermsResolver,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
    ...(noStorage ? {} : { listingPhotoStorage: storage }),
  });
  let currentActor: MarketplaceApiEnv["Variables"]["actor"] = actor;
  const errors: Error[] = [];
  const app = new Hono<MarketplaceApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    await next();
  });
  app.onError((error, c) => {
    errors.push(error);
    return c.text("Internal Server Error", 500);
  });
  app.route("/api/marketplace", buildMarketplaceApi({ ...services, listings }));
  return {
    app,
    storage,
    sourceBody,
    readObject,
    putObject,
    readStream,
    db,
    errors,
    setActor: (value: typeof currentActor) => {
      currentActor = value;
    },
    async retire(status: "replaced" | "removed") {
      await eventStore.appendToStream({
        streamId: `marketplace.listing-${listingId}`,
        expectedVersion: 1,
        context,
        events: [
          status === "removed"
            ? { eventType: "marketplace.listing.photo-removed", payload: { photoId } }
            : {
                eventType: "marketplace.listing.photo-replaced",
                payload: {
                  replacedPhotoId: photoId,
                  photo: { ...photo, photoId: createId("lpho"), replacesPhotoId: photoId },
                },
              },
        ],
      });
    },
  };
}

describe("listing-photo-jpeg-download", () => {
  it("serves source width, white alpha, fixed quality and exact private byte/hash headers repeatedly", async () => {
    const f = await fixture();
    const response = await f.app.request(route);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(response.headers.get("etag")).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    expect(await sharp(body).metadata()).toMatchObject({ format: "jpeg", width: 1200, height: 800, hasAlpha: false });
    const white = await sharp(body).extract({ left: 16, top: 16, width: 1, height: 1 }).raw().toBuffer();
    expect([...white]).toEqual([255, 255, 255]);
    const expected = await sharp(f.sourceBody)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 90 })
      .toBuffer();
    expect(body.equals(expected)).toBe(true);
    const repeated = await f.app.request(route, { headers: { "If-None-Match": response.headers.get("etag")! } });
    expect(repeated.status).toBe(200);
    expect(Buffer.from(await repeated.arrayBuffer()).equals(body)).toBe(true);
    expect(f.readObject.mock.calls).toEqual([[sourceKey], [sourceKey]]);
    expect(f.putObject).not.toHaveBeenCalled();
    f.setActor({ ...actor, accountId: foreign });
    expect((await f.app.request(route)).status).toBe(404);
    expect(f.readObject).toHaveBeenCalledTimes(2);
  });
});

describe("listing-photo-jpeg-download-isolation", () => {
  it.each(["foreign account", "missing listing", "missing photo", "replaced", "removed", "missing source"] as const)(
    "%s returns the shipped seller listing 404 with no unauthorized object read",
    async (failure) => {
      const f = await fixture();
      // Candidate-green control: identical source/listing/photo before varying one boundary.
      expect((await f.app.request(route)).status).toBe(200);
      const canonical = await f.app.request(`/api/marketplace/account/listings/${createId("lst")}`);
      expect(canonical.status).toBe(404);
      f.readObject.mockClear();
      let target = route;
      if (failure === "foreign account") f.setActor({ ...actor, accountId: foreign });
      if (failure === "missing listing") target = route.replace(listingId, createId("lst"));
      if (failure === "missing photo") target = route.replace(photoId, createId("lpho"));
      if (failure === "replaced" || failure === "removed") await f.retire(failure);
      if (failure === "missing source") await f.storage.deleteObjects([sourceKey]);
      const response = await f.app.request(target);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(await canonical.text());
      expect(f.readObject).toHaveBeenCalledTimes(failure === "missing source" ? 1 : 0);
    },
  );

  it("rejects anonymous and permission-denied requests before listing or object I/O", async () => {
    const f = await fixture();
    f.setActor(null);
    expect((await f.app.request(route)).status).toBe(401);
    f.setActor({ ...actor, permissions: ["listings.manage"] });
    expect((await f.app.request(route)).status).toBe(403);
    expect(f.readStream).not.toHaveBeenCalled();
    expect(f.db.query).not.toHaveBeenCalled();
    expect(f.readObject).not.toHaveBeenCalled();
  });

  it.each([
    ["lst_bad", photoId],
    ["lpho_01ARZ3NDEKTSV4RRFFQ69G5FAV", photoId],
    [listingId, "lpho_bad"],
    [listingId, "lst_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
    ["lst_ZZZZZZZZZZZZZZZZZZZZZZZZZZ", photoId],
    [listingId, "lpho_"],
  ])("rejects malformed or wrong-prefix ids %s / %s before admission and I/O", async (id, photo) => {
    const resolver = vi.fn<RateLimitRuleResolver>(async (_surface, defaults) => defaults);
    const f = await fixture(resolver);
    const response = await f.app.request(`/api/marketplace/account/listings/${id}/photos/${photo}/jpeg`);
    expect(response.status).toBe(400);
    expect(resolver).not.toHaveBeenCalled();
    expect(f.readStream).not.toHaveBeenCalled();
    expect(f.db.query).not.toHaveBeenCalled();
    expect(f.readObject).not.toHaveBeenCalled();
  });

  it.each(["storage", "decode", "listing", "unconfigured"])(
    "keeps %s failures visible as unsuccessful responses",
    async (failure) => {
      const f = await fixture(
        undefined,
        failure === "decode" ? Buffer.from("synthetic corrupt WebP") : undefined,
        failure === "unconfigured",
      );
      if (failure === "storage") f.readObject.mockRejectedValue(new Error("Synthetic storage failure"));
      if (failure === "listing") f.readStream.mockRejectedValue(new Error("Synthetic stream failure"));
      const response = await f.app.request(route);
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).not.toBe("image/jpeg");
      expect(response.headers.get("etag")).toBeNull();
      expect(f.errors).toHaveLength(1);
    },
  );

  it.each(["absent", "unavailable", "override", "disabled"] as const)(
    "applies %s policy with independent account buckets and a deterministic clock",
    async (mode) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const resolver = vi.fn<RateLimitRuleResolver>(async (_surface, defaults) => {
        if (mode === "unavailable") throw new Error("Synthetic policy outage");
        return mode === "override" ? { max: 2, windowMs: 5000 } : { ...defaults, disabled: mode === "disabled" };
      });
      const f = await fixture(mode === "absent" ? undefined : resolver);
      // Missing source avoids repeated encoding while exercising actual listing and object reads.
      await f.storage.deleteObjects([sourceKey]);
      const count = mode === "override" ? 2 : 30;
      for (let i = 0; i < count; i++) expect((await f.app.request(route)).status).toBe(404);
      f.readStream.mockClear();
      f.readObject.mockClear();
      f.db.query.mockClear();
      const response = await f.app.request(route);
      if (mode === "disabled") {
        expect(response.status).toBe(404);
      } else {
        expect(response.status).toBe(429);
        expect(response.headers.get("retry-after")).toBe(mode === "override" ? "5" : "600");
        expect(await response.json()).toMatchObject({
          error: { code: "rate_limited", surface: "marketplace.listing-photo.jpeg-download.account" },
        });
        expect(f.readStream).not.toHaveBeenCalled();
        expect(f.readObject).not.toHaveBeenCalled();
        expect(f.db.query).not.toHaveBeenCalled();
        f.setActor({ ...actor, accountId: foreign });
        expect((await f.app.request(route)).status).toBe(404);
        expect(f.readObject).not.toHaveBeenCalled();
        f.setActor(actor);
        now += mode === "override" ? 5000 : 600_000;
        expect((await f.app.request(route)).status).toBe(404);
      }
      if (mode !== "absent")
        expect(resolver).toHaveBeenCalledWith("marketplace.listing-photo.jpeg-download.account", {
          max: 30,
          windowMs: 600_000,
        });
    },
  );
});

describe("listing-photo-jpeg-size-budget", () => {
  // #7762, 2026-09-12 create-form capture: photoListingCreateForm format="JPG", maxBytesDisplayed="15 MB".
  // https://github.com/chase-sets/chase-sets/issues/7762#issuecomment-5647639116
  // Only the displayed format/limit is used here; the provider's minimum width stays downstream.
  it("encodes synthetic textured alpha-bearing 4032 x 3024 below captured JPG / 15 MB at quality 90", async () => {
    const f = await fixture(undefined, await alphaSource(4032, 3024));
    const response = await f.app.request(route);
    expect(response.status).toBe(200);
    const body = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(body).metadata();
    expect(metadata).toMatchObject({ format: "jpeg", width: 4032, height: 3024 });
    expect(body.length).toBeLessThan(15_000_000);
    console.info(
      `Synthetic JPG / captured 15 MB: 4032x3024, quality=90, bytes=${body.length}, decodedWidth=${metadata.width}`,
    );
  });

  it("rejects more than 24,000,000 decoded pixels before JPEG success", async () => {
    const source = await sharp({ create: { width: 5000, height: 4801, channels: 4, background: "white" } })
      .webp({ lossless: true })
      .toBuffer();
    const f = await fixture(undefined, source);
    const response = await f.app.request(route);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).not.toBe("image/jpeg");
    expect(f.errors[0].message).toMatch(/pixel limit/i);
  });

  it("does not send oversized encoded output or reduce width/quality to fit", async () => {
    const f = await fixture(undefined, await alphaSource(5000, 4800));
    const response = await f.app.request(route);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).not.toBe("image/jpeg");
    expect(response.headers.get("etag")).toBeNull();
    expect(f.errors[0].message).toBe("Listing photo JPEG exceeds the byte budget.");
    expect(f.putObject).not.toHaveBeenCalled();
  });
});
