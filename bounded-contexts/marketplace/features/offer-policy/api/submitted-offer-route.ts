import { ZodError } from "zod";
import { MarketplaceApiError, type BuyerOfferPolicySnapshot, type createMarketplaceApiClient } from "../../../client";
import { buyerOfferPolicyIdSchema, buyerOfferPolicyRequestSchema } from "../domain/contracts";

export async function submittedOfferPolicyAction(request: Request, api: ReturnType<typeof createMarketplaceApiClient>) {
  let currentPolicyId: string | null = null;
  const afterCommand = async (write: Promise<BuyerOfferPolicySnapshot>) => {
    const policy = await write;
    return { policy, error: null };
  };
  try {
    const form = await request.formData();
    const policyId = buyerOfferPolicyIdSchema.parse(form.get("policyId"));
    currentPolicyId = policyId;
    if (form.get("intent") === "load-policy") return { policy: await api.getBuyerOfferPolicy(policyId), error: null };
    const command = buyerOfferPolicyRequestSchema.parse(JSON.parse(String(form.get("command"))));
    if (command.type === "StopBuyerOfferPolicy" && form.get("confirmStop") !== "true")
      return { policy: null, error: "invalid_authority" };
    if (command.type === "PreviewBuyerOfferPolicy" && command.expectedVersion === 0) {
      const draft = await api.commandBuyerOfferPolicy(policyId, {
        type: "CreateBuyerOfferPolicy",
        expectedVersion: 0,
        operationId: `create_${policyId}`,
      });
      return await afterCommand(api.commandBuyerOfferPolicy(policyId, { ...command, expectedVersion: draft.version }));
    }
    return await afterCommand(api.commandBuyerOfferPolicy(policyId, command));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return { policy: null, error: "invalid_authority" };
    if (error instanceof MarketplaceApiError) {
      const body = error.body as { error?: { code?: string } } | null;
      const stale = body?.error?.code === "stale_preview";
      return {
        policy: stale && currentPolicyId ? await api.getBuyerOfferPolicy(currentPolicyId) : null,
        error: stale ? "stale_preview" : "invalid_authority",
      };
    }
    throw error;
  }
}
