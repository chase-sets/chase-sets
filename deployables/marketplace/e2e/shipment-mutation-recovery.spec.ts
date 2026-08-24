import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const recoveryModulePath = fileURLToPath(
  new URL("../../../bounded-contexts/fulfillment/features/shipments/ui/mutation-recovery.ts", import.meta.url),
).replaceAll("\\", "/");
const recoveryModuleUrl = `/@fs/${recoveryModulePath}`;
const packingModulePath = fileURLToPath(
  new URL("../../../bounded-contexts/fulfillment/features/shipments/ui/shipment-packing-page.tsx", import.meta.url),
).replaceAll("\\", "/");
const packingModuleUrl = `/@fs/${packingModulePath}`;

test.describe("shipment-mutation-recovery", () => {
  test("persists the production encrypted descriptor before transport and survives a browser reload", async ({
    page,
  }) => {
    await page.goto("/");
    const first = await page.evaluate(async (moduleUrl) => {
      const recovery = await import(moduleUrl);
      await recovery.purgeAllShipmentMutationRecovery();
      const descriptor = await recovery.persistShipmentMutationDescriptor({
        tenantId: "tnt_browser_7171",
        sellerAccountId: "acc_browser_7171",
        shipmentId: "shp_browser_7171",
        command: "confirm-packing-line",
        target: "spl_1",
        intentHash: await recovery.hashShipmentMutationIntent({ lineId: "spl_1", confirmed: true }),
      });
      return {
        id: descriptor.mutationAttemptId,
        descriptors: await recovery.listShipmentMutationDescriptors("tnt_browser_7171", "acc_browser_7171"),
      };
    }, recoveryModuleUrl);
    expect(first.descriptors).toHaveLength(1);
    expect(first.descriptors[0]).toMatchObject({ state: "submitting", sentAt: null });

    await page.reload();
    const restored = await page.evaluate(
      async ({ moduleUrl, id }) => {
        const recovery = await import(moduleUrl);
        const descriptors = await recovery.listShipmentMutationDescriptors("tnt_browser_7171", "acc_browser_7171");
        return descriptors.map((descriptor: { mutationAttemptId: string }) => descriptor.mutationAttemptId === id);
      },
      { moduleUrl: recoveryModuleUrl, id: first.id },
    );
    expect(restored).toEqual([true]);
  });

  test("fails closed at the Tenant/Account capacity bound without issuing a POST or evicting nonterminal recovery", async ({
    page,
  }) => {
    let postCount = 0;
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") postCount += 1;
      await route.continue();
    });
    await page.goto("/");
    const result = await page.evaluate(async (moduleUrl) => {
      const recovery = await import(moduleUrl);
      await recovery.purgeAllShipmentMutationRecovery();
      for (let index = 0; index < recovery.SHIPMENT_MUTATION_RECOVERY_MAX_NONTERMINAL; index += 1) {
        await recovery.persistShipmentMutationDescriptor({
          tenantId: "tnt_cap_7171",
          sellerAccountId: "acc_cap_7171",
          shipmentId: `shp_${index}`,
          command: "confirm-packing-line",
          target: `spl_${index}`,
          intentHash: await recovery.hashShipmentMutationIntent({ index }),
        });
      }
      let refused = false;
      try {
        await recovery.persistShipmentMutationDescriptor({
          tenantId: "tnt_cap_7171",
          sellerAccountId: "acc_cap_7171",
          shipmentId: "shp_over_cap",
          command: "confirm-packing-line",
          target: "spl_over_cap",
          intentHash: await recovery.hashShipmentMutationIntent({ index: 256 }),
        });
      } catch (error) {
        refused = error instanceof Error && error.name === "ShipmentRecoveryStorageRequiredError";
      }
      return {
        refused,
        retained: (await recovery.listShipmentMutationDescriptors("tnt_cap_7171", "acc_cap_7171")).length,
      };
    }, recoveryModuleUrl);

    expect(result).toEqual({ refused: true, retained: 256 });
    expect(postCount).toBe(0);
  });

  test("reclaims 256 terminal descriptors transactionally while retaining the 256-nonterminal refusal", async ({
    page,
  }) => {
    let postCount = 0;
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") postCount += 1;
      await route.continue();
    });
    await page.goto("/");
    const result = await page.evaluate(async (moduleUrl) => {
      const recovery = await import(moduleUrl);
      await recovery.purgeAllShipmentMutationRecovery();
      for (let index = 0; index < recovery.SHIPMENT_MUTATION_RECOVERY_MAX_NONTERMINAL; index += 1) {
        const descriptor = await recovery.persistShipmentMutationDescriptor({
          tenantId: "tnt_terminal_cap_7171",
          sellerAccountId: "acc_terminal_cap_7171",
          shipmentId: `shp_terminal_${index}`,
          command: "confirm-packing-line",
          target: `spl_terminal_${index}`,
          intentHash: await recovery.hashShipmentMutationIntent({ index }),
        });
        await recovery.updateShipmentMutationDescriptor(descriptor, { state: "succeeded" });
      }
      const accepted = await recovery.persistShipmentMutationDescriptor({
        tenantId: "tnt_terminal_cap_7171",
        sellerAccountId: "acc_terminal_cap_7171",
        shipmentId: "shp_after_terminal_cap",
        command: "confirm-packing-line",
        target: "spl_after_terminal_cap",
        intentHash: await recovery.hashShipmentMutationIntent({ index: 256 }),
      });
      return {
        accepted: accepted.mutationAttemptId,
        retained: (await recovery.listShipmentMutationDescriptors("tnt_terminal_cap_7171", "acc_terminal_cap_7171"))
          .length,
      };
    }, recoveryModuleUrl);
    expect(result.accepted).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.retained).toBe(1);
    expect(postCount).toBe(0);
  });

  test("confirm then unconfirm crosses the production packing route boundary with distinct UUIDv4 attempts", async ({
    page,
  }) => {
    const attempts: string[] = [];
    await page.route("**/account/sales/shipments/shp_browser_route/packing", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postData() ?? "";
      const attempt = body.match(/name="mutationAttemptId"\r?\n\r?\n([^\r\n]+)/)?.[1] ?? "";
      attempts.push(attempt);
      const confirmedQuantity = attempts.length === 1 ? 1 : 0;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          lineId: "spl_browser_route",
          confirmedQuantity,
        }),
      });
    });
    await page.goto("/");
    const quantities = await page.evaluate(
      async ({ recoveryUrl, packingUrl }) => {
        const recovery = await import(recoveryUrl);
        const packing = await import(packingUrl);
        await recovery.purgeAllShipmentMutationRecovery();
        const base = {
          recoveryScope: { tenantId: "tnt_browser_route", sellerAccountId: "acc_browser_route" },
          shipmentId: "shp_browser_route",
          lineId: "spl_browser_route",
          action: "/account/sales/shipments/shp_browser_route/packing",
        };
        const confirmed = await packing.submitPackingLineQuantity({ ...base, confirmedQuantity: 1 });
        const unconfirmed = await packing.submitPackingLineQuantity({ ...base, confirmedQuantity: 0 });
        return [confirmed.confirmedQuantity, unconfirmed.confirmedQuantity];
      },
      { recoveryUrl: recoveryModuleUrl, packingUrl: packingModuleUrl },
    );
    expect(quantities).toEqual([1, 0]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(attempts[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(attempts[0]).not.toBe(attempts[1]);
  });

  test("purges a record whose AES-GCM identity binding was tampered and never manufactures a recovery write", async ({
    page,
  }) => {
    let postCount = 0;
    await page.route("**/*", async (route) => {
      if (route.request().method() === "POST") postCount += 1;
      await route.continue();
    });
    await page.goto("/");
    const retained = await page.evaluate(async (moduleUrl) => {
      const recovery = await import(moduleUrl);
      await recovery.purgeAllShipmentMutationRecovery();
      await recovery.persistShipmentMutationDescriptor({
        tenantId: "tnt_tamper_7171",
        sellerAccountId: "acc_tamper_7171",
        shipmentId: "shp_tamper_7171",
        command: "dispatch-shipment",
        intentHash: await recovery.hashShipmentMutationIntent({ command: "dispatch-shipment" }),
      });
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("chase-sets-fulfillment-mutation-recovery-v1", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("descriptors", "readwrite");
        const store = transaction.objectStore("descriptors");
        const request = store.getAll();
        request.onsuccess = () => {
          const record = request.result[0];
          store.delete(record.id);
          record.id = "tampered-record-identity";
          store.put(record);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      return (await recovery.listShipmentMutationDescriptors("tnt_tamper_7171", "acc_tamper_7171")).length;
    }, recoveryModuleUrl);

    expect(retained).toBe(0);
    expect(postCount).toBe(0);
  });
});
