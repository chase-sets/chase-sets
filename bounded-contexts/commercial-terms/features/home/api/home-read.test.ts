import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import type { CommercialAgreementRow } from "../../agreements/read-model/queries";
import type { CommercialTermsScheduleRow } from "../../schedules/read-model/queries";
import {
  CommercialTermsHomeIncompleteError,
  createHomeRuntime,
  resolveCommercialTermsHome,
  type HomeServices,
} from "./home-read";
import { createHomeRoutes } from "./route";

const resolvedAt = "2026-07-15T12:00:00.000Z";

function schedule(overrides: Partial<CommercialTermsScheduleRow> = {}): CommercialTermsScheduleRow {
  return {
    schedule_id: "cts_business",
    label: "Current business terms",
    account_type: "business",
    marketplace_sales_fee_percentage_bps: 700,
    marketplace_sales_fee_fixed_amount: "0.25",
    shipping_allowance_percentage_bps: 650,
    status: "active",
    effective_from: "2026-07-01T00:00:00.000Z",
    effective_until: null,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function agreement(overrides: Partial<CommercialAgreementRow> = {}): CommercialAgreementRow {
  return {
    agreement_id: "cag_seller",
    account_id: "acc_seller",
    account_name: "Demo Account",
    account_display_name: "Seller Studio",
    account_type: "business",
    label: "Launch override",
    marketplace_sales_fee_percentage_bps: 0,
    marketplace_sales_fee_fixed_amount: "0.00",
    shipping_allowance_percentage_bps: 500,
    status: "active",
    effective_from: "2026-07-10T00:00:00.000Z",
    effective_until: null,
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function resolve(
  schedules: readonly CommercialTermsScheduleRow[],
  agreements: readonly CommercialAgreementRow[] = [],
  scheduleId: string | null = null,
) {
  return resolveCommercialTermsHome({ schedules, agreements, resolvedAt, scheduleId });
}

const launchSeed = {
  label: null,
  marketplace_sales_fee_percentage_bps: 850,
  marketplace_sales_fee_fixed_amount: "0.10",
  shipping_allowance_percentage_bps: 500,
  status: "active",
  effective_from: resolvedAt,
  effective_until: null,
};

describe("commercial terms home read: schedule in effect", () => {
  it("treats a start at resolvedAt as in effect and an end at resolvedAt as ended", () => {
    const startsNow = schedule({ schedule_id: "cts_starts_now", effective_from: resolvedAt });
    const endsNow = schedule({
      schedule_id: "cts_ends_now",
      account_type: "personal",
      effective_from: "2026-01-01T00:00:00.000Z",
      effective_until: resolvedAt,
    });

    const home = resolve([startsNow, endsNow]);

    expect(home.schedulesInEffect.business?.schedule_id).toBe("cts_starts_now");
    expect(home.schedulesInEffect.personal).toBeNull();
    expect(home.activeTerms.map((term) => term.id)).toEqual(["cts_starts_now"]);
    expect(home.activeTerms[0]).toMatchObject({ phase: "in_effect", phaseAt: resolvedAt });
  });

  it("ignores inactive schedules for the schedule in effect and the active terms", () => {
    const home = resolve([schedule({ status: "inactive" })]);

    expect(home.schedulesInEffect.business).toBeNull();
    expect(home.activeTerms).toEqual([]);
  });

  it("keeps an ended schedule out of the active terms", () => {
    const ended = schedule({ effective_from: "2026-01-01T00:00:00.000Z", effective_until: "2026-07-01T00:00:00.000Z" });

    const home = resolve([ended]);

    expect(home.schedulesInEffect.business).toBeNull();
    expect(home.activeTerms).toEqual([]);
  });

  it("breaks a start tie by latest update, then by ID descending", () => {
    const start = "2026-07-01T00:00:00.000Z";
    const olderUpdate = schedule({
      schedule_id: "cts_z",
      effective_from: start,
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    const newerUpdate = schedule({
      schedule_id: "cts_a",
      effective_from: start,
      updated_at: "2026-06-02T00:00:00.000Z",
    });
    expect(resolve([olderUpdate, newerUpdate]).schedulesInEffect.business?.schedule_id).toBe("cts_a");

    const sameUpdateA = schedule({ schedule_id: "cts_a", effective_from: start });
    const sameUpdateB = schedule({ schedule_id: "cts_b", effective_from: start });
    expect(resolve([sameUpdateA, sameUpdateB]).schedulesInEffect.business?.schedule_id).toBe("cts_b");
    expect(resolve([sameUpdateB, sameUpdateA]).schedulesInEffect.business?.schedule_id).toBe("cts_b");
  });

  it("chooses the latest started schedule in effect", () => {
    const older = schedule({ schedule_id: "cts_older", effective_from: "2026-06-01T00:00:00.000Z" });
    const newer = schedule({ schedule_id: "cts_newer", effective_from: "2026-07-01T00:00:00.000Z" });
    const upcoming = schedule({ schedule_id: "cts_upcoming", effective_from: "2026-08-01T00:00:00.000Z" });

    expect(resolve([older, upcoming, newer]).schedulesInEffect.business?.schedule_id).toBe("cts_newer");
  });

  it("resolves the schedule in effect separately for each account type", () => {
    const personal = schedule({ schedule_id: "cts_personal", account_type: "personal" });
    const enterprise = schedule({ schedule_id: "cts_enterprise", account_type: "enterprise" });

    const home = resolve([personal, enterprise]);

    expect(home.schedulesInEffect).toEqual({
      personal: expect.objectContaining({ schedule_id: "cts_personal" }),
      business: null,
      enterprise: expect.objectContaining({ schedule_id: "cts_enterprise" }),
    });
  });

  it("normalizes PostgreSQL timestamp values to ISO strings before comparing", () => {
    const fromDatabase = schedule({
      effective_from: new Date("2026-07-15T12:00:00.000Z") as unknown as string,
      effective_until: new Date("2026-07-15T12:00:00.001Z") as unknown as string,
      created_at: new Date("2026-06-01T00:00:00.000Z") as unknown as string,
      updated_at: new Date("2026-06-02T00:00:00.000Z") as unknown as string,
    });

    const home = resolve([fromDatabase]);

    expect(home.schedulesInEffect.business).toMatchObject({
      effective_from: resolvedAt,
      effective_until: "2026-07-15T12:00:00.001Z",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-02T00:00:00.000Z",
    });
    expect(home.activeTerms[0]).toMatchObject({ phase: "in_effect", phaseAt: resolvedAt });
  });
});

describe("commercial terms home read: active terms", () => {
  it("orders every active, not-ended term by start descending then ID ascending, future terms included", () => {
    const home = resolve(
      [
        schedule({ schedule_id: "cts_active", effective_from: "2026-07-01T00:00:00.000Z" }),
        schedule({ schedule_id: "cts_upcoming", effective_from: "2026-08-01T00:00:00.000Z" }),
        schedule({ schedule_id: "cts_inactive", status: "inactive" }),
      ],
      [
        agreement({ agreement_id: "cag_b", effective_from: "2026-07-10T00:00:00.000Z" }),
        agreement({ agreement_id: "cag_a", effective_from: "2026-07-10T00:00:00.000Z" }),
        agreement({ agreement_id: "cag_ended", effective_until: "2026-07-12T00:00:00.000Z" }),
      ],
    );

    expect(home.activeTerms.map((term) => `${term.kind}:${term.id}`)).toEqual([
      "schedule:cts_upcoming",
      "agreement:cag_a",
      "agreement:cag_b",
      "schedule:cts_active",
    ]);
  });

  it("assigns each phase and the instant it refers to", () => {
    const home = resolve(
      [
        schedule({ schedule_id: "cts_upcoming", effective_from: "2026-08-01T00:00:00.000Z" }),
        schedule({
          schedule_id: "cts_bounded",
          account_type: "personal",
          effective_from: "2026-07-01T00:00:00.000Z",
          effective_until: "2026-09-01T00:00:00.000Z",
        }),
      ],
      [
        agreement({
          agreement_id: "cag_future",
          effective_from: "2026-08-01T00:00:00.000Z",
          effective_until: "2026-09-01T00:00:00.000Z",
        }),
        agreement({ agreement_id: "cag_expiring", effective_until: "2026-08-15T00:00:00.000Z" }),
        agreement({ agreement_id: "cag_open", effective_from: "2026-07-05T00:00:00.000Z" }),
      ],
    );
    const phases = Object.fromEntries(home.activeTerms.map((term) => [term.id, [term.phase, term.phaseAt]]));

    expect(phases).toEqual({
      cts_upcoming: ["scheduled", "2026-08-01T00:00:00.000Z"],
      cts_bounded: ["in_effect", "2026-07-01T00:00:00.000Z"],
      cag_future: ["scheduled", "2026-08-01T00:00:00.000Z"],
      cag_expiring: ["expiring", "2026-08-15T00:00:00.000Z"],
      cag_open: ["in_effect", "2026-07-05T00:00:00.000Z"],
    });
  });
});

describe("commercial terms home read: starting terms", () => {
  it("seeds every create form with the business launch fees when no schedule is in effect", () => {
    const home = resolve([schedule({ account_type: "personal", status: "inactive" })]);

    expect(home.startingTerms).toEqual({
      schedule: launchSeed,
      override: { personal: launchSeed, business: launchSeed, enterprise: launchSeed, default: launchSeed },
    });
    for (const seed of [home.startingTerms.schedule, ...Object.values(home.startingTerms.override)]) {
      expect(seed.marketplace_sales_fee_percentage_bps).not.toBe(900);
      expect(seed.marketplace_sales_fee_percentage_bps).not.toBe(600);
      expect(seed.marketplace_sales_fee_fixed_amount).toBe("0.10");
      expect(seed.shipping_allowance_percentage_bps).toBe(500);
    }
  });

  it("copies the schedule in effect for its account type and falls back to business launch fees for the rest", () => {
    const business = schedule({
      effective_from: "2026-07-01T00:00:00.000Z",
      effective_until: "2026-12-01T00:00:00.000Z",
    });
    const businessSeed = {
      label: "Current business terms",
      marketplace_sales_fee_percentage_bps: 700,
      marketplace_sales_fee_fixed_amount: "0.25",
      shipping_allowance_percentage_bps: 650,
      status: "active",
      effective_from: "2026-07-01T00:00:00.000Z",
      effective_until: "2026-12-01T00:00:00.000Z",
    };

    const home = resolve(
      [business, schedule({ schedule_id: "cts_later", effective_from: "2026-08-01T00:00:00.000Z" })],
      [agreement()],
    );

    expect(home.startingTerms.schedule).toEqual(businessSeed);
    expect(home.startingTerms.override).toEqual({
      personal: launchSeed,
      business: businessSeed,
      enterprise: launchSeed,
      default: launchSeed,
    });
  });
});

describe("commercial terms home read: schedule comparison", () => {
  const current = schedule({ schedule_id: "cts_current", effective_from: "2026-07-01T00:00:00.000Z" });
  const previous = schedule({ schedule_id: "cts_previous", effective_from: "2026-06-01T00:00:00.000Z" });
  const upcoming = schedule({ schedule_id: "cts_upcoming", effective_from: "2026-08-01T00:00:00.000Z" });
  const personal = schedule({ schedule_id: "cts_personal", account_type: "personal" });

  it("compares a selected schedule that is not in effect with the schedule in effect for its type", () => {
    expect(resolve([current, upcoming, personal], [], "cts_upcoming").scheduleComparison?.schedule_id).toBe(
      "cts_current",
    );
  });

  it("compares the selected schedule in effect with the next schedule in effect for its type, excluding itself", () => {
    expect(resolve([current, previous, personal], [], "cts_current").scheduleComparison?.schedule_id).toBe(
      "cts_previous",
    );
    expect(resolve([current, personal], [], "cts_current").scheduleComparison).toBeNull();
  });

  it("returns no comparison for an unknown or absent schedule ID", () => {
    expect(resolve([current], [], "cts_unknown").scheduleComparison).toBeNull();
    expect(resolve([current], [], null).scheduleComparison).toBeNull();
  });
});

describe("commercial terms home runtime: bounded sources", () => {
  function rows<T>(count: number, row: (index: number) => T) {
    return Array.from({ length: count }, (_, index) => row(index));
  }

  function runtime(
    schedules: Readonly<{ items: CommercialTermsScheduleRow[]; total: number }>,
    agreements: Readonly<{ items: CommercialAgreementRow[]; total: number }> = { items: [], total: 0 },
  ) {
    const listSchedules = vi.fn(async () => schedules);
    const listAgreements = vi.fn(async () => agreements);
    return {
      listSchedules,
      listAgreements,
      home: createHomeRuntime({ schedules: { listSchedules }, agreements: { listAgreements } }),
    };
  }

  it("reads both sources from the first offset at the list cap and returns a reconciled envelope", async () => {
    const full = rows(250, (index) =>
      schedule({ schedule_id: `cts_${String(index).padStart(3, "0")}`, status: "inactive" }),
    );
    const { home, listSchedules, listAgreements } = runtime(
      { items: full, total: full.length },
      { items: [agreement()], total: 1 },
    );

    const result = await home.readHome({ resolvedAt, scheduleId: null });

    expect(listSchedules).toHaveBeenCalledWith({ limit: 250, offset: 0 });
    expect(listAgreements).toHaveBeenCalledWith({ limit: 250, offset: 0 });
    expect(result.resolvedAt).toBe(resolvedAt);
    expect(result.activeTerms.map((term) => term.id)).toEqual(["cag_seller"]);
  });

  it.each(["schedules", "agreements"] as const)("refuses a 250 + 1 %s tail instead of truncating", async (source) => {
    const capped = { items: rows(250, (index) => schedule({ schedule_id: `cts_${index}` })), total: 251 };
    const cappedAgreements = { items: rows(250, (index) => agreement({ agreement_id: `cag_${index}` })), total: 251 };
    const { home } = source === "schedules" ? runtime(capped) : runtime({ items: [], total: 0 }, cappedAgreements);

    await expect(home.readHome({ resolvedAt, scheduleId: null })).rejects.toBeInstanceOf(
      CommercialTermsHomeIncompleteError,
    );
    await expect(home.readHome({ resolvedAt, scheduleId: null })).rejects.toMatchObject({
      source,
      rowCount: 250,
      total: 251,
    });
  });

  it("refuses rows that do not reconcile with the independent count", async () => {
    const { home } = runtime({ items: [schedule()], total: 2 });

    await expect(home.readHome({ resolvedAt, scheduleId: null })).rejects.toMatchObject({
      source: "schedules",
      rowCount: 1,
      total: 2,
    });
  });
});

describe("GET /api/commercial-terms/home", () => {
  function createApp(
    services: HomeServices,
    permissions: readonly string[] | null,
    clock = () => new Date(resolvedAt),
  ) {
    const app = new Hono<CommercialTermsApiEnv>();
    app.use("*", async (c, next) => {
      if (permissions) {
        c.set("actor", {
          sessionId: "ses_test",
          tenantId: "tnt_test",
          userId: "usr_admin",
          accountId: "acc_admin",
          membershipId: "mem_test",
          roleKey: "admin",
          permissions,
        });
      }
      await next();
    });
    app.route("/", createHomeRoutes(services, clock));
    return app;
  }

  it.each([
    [null, 401, "authentication_required"],
    [["commercial-terms.manage"], 403, "authorization_forbidden"],
  ] as const)("refuses permissions %j with %i", async (permissions, status, code) => {
    const readHome = vi.fn();
    const response = await createApp({ readHome }, permissions).request("/");

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(readHome).not.toHaveBeenCalled();
  });

  it("captures one resolvedAt per request and derives the whole envelope from it", async () => {
    const clock = vi.fn(() => new Date(resolvedAt));
    const listSchedules = vi.fn(async () => ({
      items: [
        schedule({ schedule_id: "cts_current" }),
        schedule({ schedule_id: "cts_upcoming", effective_from: "2026-08-01T00:00:00.000Z" }),
      ],
      total: 2,
    }));
    const listAgreements = vi.fn(async () => ({
      items: [agreement({ effective_until: "2026-08-15T00:00:00.000Z" })],
      total: 1,
    }));
    const services = createHomeRuntime({ schedules: { listSchedules }, agreements: { listAgreements } });

    const response = await createApp(services, ["commercial-terms.view"], clock).request("/?schedule=cts_upcoming");

    expect(response.status).toBe(200);
    expect(clock).toHaveBeenCalledOnce();
    const body = await response.json();
    expect(body).toMatchObject({
      resolvedAt,
      schedulesInEffect: { business: { schedule_id: "cts_current" }, personal: null, enterprise: null },
      scheduleComparison: { schedule_id: "cts_current" },
      startingTerms: { schedule: { label: "Current business terms", effective_from: "2026-07-01T00:00:00.000Z" } },
    });
    expect(body.activeTerms.map((term: { id: string; phase: string }) => [term.id, term.phase])).toEqual([
      ["cts_upcoming", "scheduled"],
      ["cag_seller", "expiring"],
      ["cts_current", "in_effect"],
    ]);
    expect(body.startingTerms.override.default).toEqual(launchSeed);
  });

  it("passes no schedule ID when the query omits or empties it", async () => {
    const readHome = vi.fn(async () => resolve([]));
    const app = createApp({ readHome }, ["commercial-terms.view"]);

    await app.request("/");
    await app.request("/?schedule=");

    expect(readHome).toHaveBeenNthCalledWith(1, { resolvedAt, scheduleId: null });
    expect(readHome).toHaveBeenNthCalledWith(2, { resolvedAt, scheduleId: null });
  });

  it("answers an incomplete source read with 503 instead of a partial envelope", async () => {
    const readHome = vi.fn(async () => {
      throw new CommercialTermsHomeIncompleteError("schedules", 250, 251);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await createApp({ readHome }, ["commercial-terms.view"]).request("/");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "commercial_terms_home_incomplete", message: "Commercial Terms unavailable" },
    });
    expect(warn).toHaveBeenCalledWith("[commercial-terms-home] incomplete source read", {
      source: "schedules",
      rowCount: 250,
      total: 251,
    });
    warn.mockRestore();
  });
});
