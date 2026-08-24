import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const recoveryModulePath = fileURLToPath(
  new URL("../../../bounded-contexts/fulfillment/features/shipments/ui/mutation-recovery.ts", import.meta.url),
).replaceAll("\\", "/");
const recoveryModuleUrl = `/@fs/${recoveryModulePath}`;

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

  test("purges tampered ciphertext and never manufactures a recovery write", async ({ page }) => {
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
          record.ciphertext = new Uint8Array([1, 2, 3, 4]).buffer;
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
