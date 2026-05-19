import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { bootstrapCatalogDatabase } from "@chase-sets/catalog/server";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import {
  bootstrapContextDatabase,
  syncContextProjectionGroups,
} from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { createAdminSupportApiHost } from "./app";
import { loadConfig } from "./config";
import {
  closeAdminSupportApiPools,
  createAdminSupportApiPools,
} from "./database-pools";

async function bootstrap() {
  const config = loadConfig();
  const pools = createAdminSupportApiPools(config);

  try {
    await bootstrapPlatformControlPlane(pools.control);
    const runtime = createAdminSupportApiHost({ pools });

    for (const context of runtime.mountedContexts) {
      await bootstrapContextDatabase(context.module, context.pool);
    }

    const catalogContext = runtime.mountedContexts.find(
      (entry) => entry.contextName === "catalog",
    );
    if (catalogContext) {
      await bootstrapCatalogDatabase(catalogContext.pool, undefined, {
        enabledDataProfiles: config.dataProfiles,
        environmentName: config.deploymentEnvironment,
      });
    }

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

    console.log("Admin support API bootstrap complete.");
  } finally {
    await closeAdminSupportApiPools(pools);
  }
}

void bootstrap().catch((error) => {
  console.error("Admin support API bootstrap failed.", error);
  process.exit(1);
});
