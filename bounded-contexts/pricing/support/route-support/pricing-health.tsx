import { useEffect, useRef } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  useNavigate,
  useRevalidator,
} from "react-router";
import { AlertDialog, Button, NativeSelect, Stack, Text } from "@chase-sets/design-system";
import { RouterForm } from "@chase-sets/design-system/react-router";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createPricingRequestApiClient, PricingApiError } from "../request-support/api-client";
import { PricingHealthPage } from "../../features/pricing-health/ui/page";
import { healthCopy as copy } from "../../features/pricing-health/ui/copy";
import type { CandidateMetrics } from "../../features/pricing-health/api/goal-comparison";
import type { GoalParameterRequest } from "../../features/pricing-health/api/goal-comparison";
import type { ApplyGoalResult } from "../../features/pricing-health/api/services";

export const PRICING_HEALTH_HREF = "/account/desk/pricing-health";
export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "pricing.view" });
  try {
    const policyId = new URL(request.url).searchParams.get("policyId") ?? undefined;
    const goalsText = new URL(request.url).searchParams.get("goals");
    let goals: GoalParameterRequest[] | undefined;
    if (goalsText !== null) {
      try {
        const parsed: unknown = JSON.parse(goalsText);
        if (!Array.isArray(parsed)) throw new Error("goals must be an array");
        goals = parsed as GoalParameterRequest[];
      } catch {
        return { data: null, loadFailed: false, error: copy("goals.validation") };
      }
    }
    return {
      data: await createPricingRequestApiClient(request).getPricingHealth(policyId, goals),
      loadFailed: false,
    };
  } catch (error) {
    if (error instanceof PricingApiError) {
      if (error.status >= 500) return { data: null, loadFailed: true };
      if (error.status === 400) return { data: null, loadFailed: false, error: copy("goals.validation") };
      throw new Response(null, { status: error.status });
    }
    throw error;
  }
}

export const action = defineFormAction({
  authorization: { permission: "pricing.manage" },
  intents: {
    compute: async ({ request, formData }) => {
      const policyId = String(formData.get("policyId") ?? "");
      await createPricingRequestApiClient(request).computePricingHealth(policyId);
      return redirect(`${PRICING_HEALTH_HREF}?${new URLSearchParams({ policyId })}`);
    },
    compare: async ({ request, formData }) => {
      const policyId = String(formData.get("policyId") ?? "");
      const goalsText = formData.get("goals") ?? new URL(request.url).searchParams.get("goals");
      const goalsValue = typeof goalsText === "string" ? goalsText : undefined;
      let goals: GoalParameterRequest[] | undefined;
      if (goalsValue) {
        try {
          const parsed: unknown = JSON.parse(goalsValue);
          if (!Array.isArray(parsed)) throw new Error("goals must be an array");
          goals = parsed as GoalParameterRequest[];
        } catch {
          return { error: copy("goals.validation") };
        }
      }
      await createPricingRequestApiClient(request).comparePricingHealth(policyId, goals);
      const query = new URLSearchParams({ policyId });
      if (goalsValue) query.set("goals", goalsValue);
      return redirect(`${PRICING_HEALTH_HREF}?${query}`);
    },
    apply: async ({ request, formData }) => {
      const policyId = String(formData.get("policyId") ?? "");
      const parameters = JSON.parse(String(formData.get("parameters") ?? "{}")) as Record<string, number>;
      const result = await createPricingRequestApiClient(request).applyPricingHealthGoal(policyId, {
        dryRunId: String(formData.get("dryRunId") ?? ""),
        targetRevision: Number(formData.get("targetRevision")),
        targetBodyHash: String(formData.get("targetBodyHash") ?? ""),
        candidateBodyHash: String(formData.get("candidateBodyHash") ?? ""),
        goalId: String(formData.get("goalId") ?? ""),
        goalVersion: Number(formData.get("goalVersion")),
        parameters,
      });
      return { applyResult: result };
    },
  },
  onUnknownIntent: () => ({ error: copy("computeError") }),
  onError: (error) => {
    if (error instanceof PricingApiError && [401, 403, 404].includes(error.status))
      throw new Response(null, { status: error.status });
    const apiCode =
      error instanceof PricingApiError &&
      error.body &&
      typeof error.body === "object" &&
      "error" in error.body &&
      error.body.error &&
      typeof error.body.error === "object" &&
      "code" in error.body.error
        ? error.body.error.code
        : null;
    return {
      error: copy(
        apiCode === "goal_apply_refused"
          ? "goals.applyError"
          : apiCode === "validation_failed"
            ? "goals.validation"
            : "computeError",
      ),
    };
  },
});

function GoalApplyConfirmation({
  candidate,
  policyId,
  targetBodyHash,
  targetRevision,
}: Readonly<{
  candidate: CandidateMetrics;
  policyId: string;
  targetBodyHash?: string;
  targetRevision: number;
}>) {
  const submitRef = useRef<HTMLButtonElement>(null);
  const formId = `pricing-health-apply-${candidate.dryRunId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const parameters = candidate.parameters ?? {};
  const ready = targetBodyHash !== undefined && candidate.status === "completed";
  return (
    <>
      <AlertDialog
        trigger={
          <Button type="button" disabled={!ready} tone="primary">
            {copy("goals.apply")}
          </Button>
        }
        title={copy("goals.confirm.title")}
        description={
          <Stack gap={2}>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.policy", { policy: policyId, revision: targetRevision, hash: targetBodyHash ?? "" })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.goal", { goal: candidate.goalId, version: candidate.goalVersion })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.parameters", { parameters: JSON.stringify(parameters) })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.bodyHash", { hash: candidate.bodyHash })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.movement", {
                raised: candidate.raised ?? 0,
                lowered: candidate.lowered ?? 0,
                held: candidate.held ?? 0,
              })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.guardrails", { guardrails: JSON.stringify(candidate.guardrails ?? []) })}
            </Text>
            <Text size="sm" wrap="anywhere">
              {copy("goals.confirm.currencyFloor", {
                currency: candidate.currencyCode ?? copy("unavailable"),
                floor: JSON.stringify(candidate.floor ?? null),
              })}
            </Text>
          </Stack>
        }
        confirmLabel={copy("goals.confirm.apply")}
        cancelLabel={copy("goals.confirm.cancel")}
        tone="warning"
        onConfirm={() => submitRef.current?.click()}
      />
      <div className="sr-only">
        <RouterForm method="post" id={formId}>
          <input type="hidden" name="intent" value="apply" />
          <input type="hidden" name="policyId" value={policyId} />
          <input type="hidden" name="dryRunId" value={candidate.dryRunId} />
          <input type="hidden" name="targetRevision" value={targetRevision} />
          <input type="hidden" name="targetBodyHash" value={targetBodyHash ?? ""} />
          <input type="hidden" name="candidateBodyHash" value={candidate.bodyHash} />
          <input type="hidden" name="goalId" value={candidate.goalId} />
          <input type="hidden" name="goalVersion" value={candidate.goalVersion} />
          <input type="hidden" name="parameters" value={JSON.stringify(parameters)} />
          <button ref={submitRef} type="submit" aria-label={copy("goals.confirm.apply")} />
        </RouterForm>
      </div>
    </>
  );
}

export default function PricingHealthRoute() {
  const { data, loadFailed, error: loaderError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { error?: string; applyResult?: ApplyGoalResult } | undefined;
  const navigation = useNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const policyId = new URLSearchParams(location.search).get("policyId");
  const errorRecoveryHref = policyId
    ? `${PRICING_HEALTH_HREF}?${new URLSearchParams({ policyId }).toString()}`
    : PRICING_HEALTH_HREF;
  useEffect(() => {
    if (!data?.computing || revalidator.state !== "idle") return;
    const timer = setTimeout(() => void revalidator.revalidate(), 2000);
    return () => clearTimeout(timer);
  }, [data?.computing, revalidator.state, revalidator.revalidate]);
  return (
    <PricingHealthPage
      data={data}
      loading={navigation.state === "loading" && navigation.formMethod?.toLowerCase() === "get"}
      error={loadFailed ? copy("error.description") : (loaderError ?? actionData?.error)}
      applyResult={actionData?.applyResult}
      goalNavigate={navigate}
      errorRecoveryHref={errorRecoveryHref}
      policySelector={
        data && data.policies.length > 1 ? (
          <RouterForm method="get" action={PRICING_HEALTH_HREF}>
            <NativeSelect
              label={copy("policy")}
              name="policyId"
              defaultValue={data.target?.policyId ?? ""}
              required
              placeholder={copy("choose")}
              items={data.policies.map(({ policyId, name }) => ({ value: policyId, label: name }))}
            />
            <Button type="submit" tone="secondary">
              {copy("show")}
            </Button>
          </RouterForm>
        ) : null
      }
      computeAction={
        data?.target && data.canCompute ? (
          <RouterForm method="post">
            <input type="hidden" name="intent" value="compute" />
            <input type="hidden" name="policyId" value={data.target.policyId} />
            <Button
              type="submit"
              disabled={navigation.state !== "idle" || data.computing}
              loading={navigation.state === "submitting"}
            >
              {copy("compute")}
            </Button>
          </RouterForm>
        ) : null
      }
      compareAction={
        data?.target && data.branch === "comparison" && data.canCompute ? (
          <RouterForm method="post">
            <input type="hidden" name="intent" value="compare" />
            <input type="hidden" name="policyId" value={data.target.policyId} />
            <Button type="submit" disabled={navigation.state !== "idle"} loading={navigation.state === "submitting"}>
              {copy("goals.compare")}
            </Button>
          </RouterForm>
        ) : null
      }
      applyAction={
        data?.target
          ? (candidate) => (
              <GoalApplyConfirmation
                candidate={candidate}
                policyId={data.target!.policyId}
                targetRevision={data.target!.version}
                targetBodyHash={data.target!.bodyHash}
              />
            )
          : undefined
      }
    />
  );
}
