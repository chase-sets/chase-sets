import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import { createFakeMoneyMovementGateway } from "@chase-sets/money-movement-testing";
import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import { syncContextProjectionGroups } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import {
  createFilesystemObjectStorage,
  createS3ObjectStorage,
} from "@chase-sets/object-storage";
import { createPlatformApiHost } from "./app";
import { loadBootstrapConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { apiContextRegistry } from "./generated/api-context-registry";

async function bootstrap() {
  const config = loadBootstrapConfig();
  const pools = createPlatformApiPools(config);

  try {
    await bootstrapPlatformControlPlane(pools.control);
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        moneyMovementGateway: createFakeMoneyMovementGateway(),
        listingPhotoStorage: config.listingPhotoStorage.kind === "s3"
          ? createS3ObjectStorage(config.listingPhotoStorage)
          : createFilesystemObjectStorage(config.listingPhotoStorage),
      },
    });
    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
      enabledDataProfiles: config.dataProfiles ?? [],
      environmentName: config.deploymentEnvironment ?? null,
    });

    if (config.platformAdmin) {
      const identityServices = runtime.services.identity as Parameters<
        typeof bootstrapPlatformAdminIdentity
      >[0];
      const authServices = runtime.services.auth as Parameters<
        typeof bootstrapPlatformAdminPassword
      >[0];
      const admin = await bootstrapPlatformAdminIdentity(identityServices, {
        email: config.platformAdmin.email,
        displayName: config.platformAdmin.displayName,
        accountName: config.platformAdmin.accountName,
      });

      await syncContextProjectionGroups(runtime, "auth");
      await bootstrapPlatformAdminPassword(authServices, {
        userId: admin.userId,
        credentialId: admin.credentialId,
        password: config.platformAdmin.password,
      });
      console.log("Platform admin bootstrap reconciled.");
    }

    console.log("Platform API bootstrap complete.");
  } finally {
    await closePlatformApiPools(pools);
  }
}

void bootstrap().catch((error) => {
  console.error("Platform API bootstrap failed.", error);
  process.exit(1);
});
