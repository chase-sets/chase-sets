// Provisioning consumes no Consent recording authorization (#8945), so the
// admin-QA surface carries no constructor reference.
async function provisionAdminQaActorFixture(userId: unknown, accountId: unknown) {
  return { userId, accountId };
}

void provisionAdminQaActorFixture;
