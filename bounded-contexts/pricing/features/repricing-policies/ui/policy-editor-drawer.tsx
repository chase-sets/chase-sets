import { useEffect, useRef, useState } from "react";
import {
  Banner,
  Button,
  Fieldset,
  Select,
  Slider,
  SideSheet,
  Skeleton,
  Stack,
  Text,
  TextInput,
  ValidationSummary,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import {
  pricingApi,
  pricingValidationMessages,
  type createPricingApiClient,
} from "../../../support/request-support/api-client";
import type { RepricingDryRun } from "../../repricing-engine/api/dry-run";
import type { RepricingPolicyListingTrace } from "../../repricing-engine/domain/fact";
import type { RepricingAuthoringPrerequisites } from "../read-model/controls";
import type { RepricingFloor, RepricingPolicyScope, RepricingRuleCondition } from "../domain/domain";
import {
  compileRepricingPreset,
  openRepricingPreset,
  repricingPresets,
  type PolicyEditorBody,
  type RepricingPreset,
} from "./presets";
import { policyControls } from "./policy-controls";
import {
  controlItems,
  editorCopy,
  newPolicyCondition,
  PolicyConditionFields,
  PolicyDirectiveFields,
  PolicyFloorFields,
  PolicyNumber,
  PolicyScopeFields,
  type PolicyCategory,
} from "./policy-controls-fields";
import { ScopePreviewPanel } from "./scope-preview-panel";
import { DryRunResult } from "./dry-run-result";

type EditorApi = Pick<
  ReturnType<typeof createPricingApiClient>,
  | "getRepricingAuthoringPrerequisites"
  | "listRepricingCategories"
  | "previewRepricingScope"
  | "startRepricingDryRun"
  | "getRepricingDryRun"
  | "listRepricingDryRunTraces"
>;
export type PolicyEditorSubmission = Readonly<{ body: PolicyEditorBody; dryRunId?: string }>;

export function PolicyEditorDrawer({
  initialBody,
  policyId,
  api = pricingApi,
  saving = false,
  saveErrors = [],
  onSave,
  onClose,
}: {
  initialBody?: PolicyEditorBody;
  policyId?: string;
  api?: EditorApi;
  saving?: boolean;
  saveErrors?: readonly string[];
  onSave: (submission: PolicyEditorSubmission) => void;
  onClose: () => void;
}) {
  const [facts, setFacts] = useState<RepricingAuthoringPrerequisites | null>(null);
  const [categories, setCategories] = useState<readonly PolicyCategory[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [preset, setPreset] = useState<RepricingPreset>("track-market");
  const [name, setName] = useState(initialBody?.name ?? t(repricingPresets["track-market"].title));
  const [currency, setCurrency] = useState("");
  const [floor, setFloor] = useState<RepricingFloor>({ mode: "absolute", amount: "" });
  const [knob, setKnob] = useState(0);
  const [age, setAge] = useState(45);
  const [scope, setScope] = useState<RepricingPolicyScope>(initialBody?.scope ?? { kind: "all-listings" });
  const [body, setBody] = useState<PolicyEditorBody | null>(initialBody ?? null);
  const [tier, setTier] = useState<"preset" | "structured" | "advanced">(
    initialBody ? openRepricingPreset(initialBody).tier : "preset",
  );
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [binding, setBinding] = useState<{ run: RepricingDryRun; revision: number } | null>(null);
  const revision = useRef(0);
  const initialized = useRef(false);
  const alive = useRef(true);
  const [traces, setTraces] = useState<readonly RepricingPolicyListingTrace[]>([]);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [samplesFailed, setSamplesFailed] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    void Promise.all([api.getRepricingAuthoringPrerequisites(), api.listRepricingCategories()]).then(
      ([nextFacts, nextCategories]) => {
        if (cancelled) return;
        setFacts(nextFacts);
        setCategories(nextCategories);
        if (!initialized.current) {
          initialized.current = true;
          setCurrency(nextFacts.listingCurrencyCodes.length === 1 ? nextFacts.listingCurrencyCodes[0]! : "");
          setFloor(
            nextFacts.hasCostBasis
              ? { mode: "cost-basis-plus-margin", marginPercent: 10, absoluteFallbackAmount: "" }
              : { mode: "absolute", amount: "" },
          );
        }
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, retry]);

  const runId = binding?.run.dryRunId;
  const runRevision = binding?.revision;
  useEffect(() => {
    if (!runId || runRevision === undefined) return;
    let cancelled = false;
    let requestSequence = 0;
    const refresh = async () => {
      const sequence = ++requestSequence;
      try {
        const run = await api.getRepricingDryRun(runId);
        if (!cancelled && sequence === requestSequence && revision.current === runRevision) {
          setBinding({ run, revision: runRevision });
          setStreamFailed(false);
        }
      } catch {
        if (!cancelled) setStreamFailed(true);
      }
    };
    const subscription = subscribeDurableJobStatus<Pick<RepricingDryRun, "status">>({
      url: `/api/marketplace/account/repricing-policies/dry-runs/${encodeURIComponent(runId)}/events`,
      onStatus: () => {
        void refresh();
      },
      onError: () => {
        if (!cancelled) setStreamFailed(true);
      },
    });
    void refresh();
    return () => {
      cancelled = true;
      subscription.close();
    };
  }, [api, runId, runRevision]);

  async function loadSamples(after?: string) {
    if (!runId) return;
    const captured = revision.current;
    setSamplesLoading(true);
    setSamplesFailed(false);
    try {
      const page = await api.listRepricingDryRunTraces(runId, after);
      if (alive.current && captured === revision.current) setTraces(page);
    } catch {
      if (alive.current && captured === revision.current) setSamplesFailed(true);
    } finally {
      if (alive.current && captured === revision.current) setSamplesLoading(false);
    }
  }
  const completed = binding?.run.status === "completed";
  useEffect(() => {
    if (completed) void loadSamples();
  }, [completed, runId]);

  function edit(change: () => void) {
    revision.current += 1;
    setBinding(null);
    setTraces([]);
    setErrors([]);
    setStreamFailed(false);
    setSamplesLoading(false);
    setSamplesFailed(false);
    change();
  }
  const candidate =
    body ?? compileRepricingPreset({ preset, name, currencyCode: currency, floor, knob, ageDays: age, scope });
  const promptComplete =
    body !== null || Boolean(currency && (floor.mode === "absolute" ? floor.amount : floor.absoluteFallbackAmount));
  async function preview() {
    const captured = revision.current;
    setPreviewing(true);
    setErrors([]);
    setBinding(null);
    try {
      const run = await api.startRepricingDryRun({
        ...candidate,
        ...(policyId ? { replacingPolicyId: policyId } : {}),
      });
      if (alive.current && captured === revision.current) setBinding({ run, revision: captured });
    } catch (error) {
      if (alive.current && captured === revision.current) {
        const details = pricingValidationMessages(error);
        setErrors(details.length ? details : [editorCopy("validationFailed")]);
      }
    } finally {
      if (alive.current) setPreviewing(false);
    }
  }
  const canActivate =
    binding?.run.status === "completed" && binding.revision === revision.current && !binding.run.consumedAt;
  const changeBody = (next: PolicyEditorBody) => edit(() => setBody(next));

  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
      width="lg"
      title={editorCopy(policyId ? "revise" : "create")}
      footer={
        <Stack direction="row" gap={2}>
          <Button
            tone="secondary"
            disabled={!facts || !promptComplete || previewing || saving}
            onClick={() => {
              void preview();
            }}
          >
            {editorCopy(previewing ? "preview.starting" : "preview.start")}
          </Button>
          <Button
            disabled={saving || !facts || !promptComplete || (!policyId && !canActivate)}
            onClick={() => onSave({ body: candidate, ...(canActivate ? { dryRunId: binding!.run.dryRunId } : {}) })}
          >
            {editorCopy(policyId ? "save" : "activate")}
          </Button>
        </Stack>
      }
    >
      <Stack gap={5} data-testid="repricing-policy-editor">
        {loadFailed ? (
          <Banner
            tone="danger"
            title={editorCopy("prerequisites.error")}
            actions={<Button onClick={() => setRetry(retry + 1)}>{editorCopy("retry")}</Button>}
          />
        ) : !facts ? (
          <Stack aria-busy gap={3}>
            <Text>{editorCopy("prerequisites.loading")}</Text>
            <Skeleton />
            <Skeleton />
          </Stack>
        ) : null}
        <ValidationSummary
          title={editorCopy("validationTitle")}
          errors={[...errors, ...saveErrors].map((message) => ({ message }))}
        />
        {facts ? (
          <Fieldset legend={editorCopy(tier === "preset" ? "presets" : tier)} inert={saving}>
            <Stack gap={4}>
              <TextInput
                label={editorCopy("name")}
                data-testid="repricing-policy-name"
                value={candidate.name}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  edit(() => (body ? setBody({ ...body, name: next }) : setName(next)));
                }}
              />
              <PolicyScopeFields
                value={candidate.scope}
                categories={categories}
                onChange={(next) => edit(() => (body ? setBody({ ...body, scope: next }) : setScope(next)))}
              />
              {tier === "preset" ? (
                <>
                  <Select
                    label={editorCopy("strategy")}
                    items={Object.entries(repricingPresets).map(([value, option]) => ({
                      value,
                      label: t(option.title),
                    }))}
                    value={preset}
                    onValueChange={(value) =>
                      edit(() => {
                        const next = value as RepricingPreset;
                        setPreset(next);
                        setName(t(repricingPresets[next].title));
                        setKnob(repricingPresets[next].defaultValue);
                        setAge(45);
                      })
                    }
                  />
                  <Text>{t(repricingPresets[preset].promise)}</Text>
                  <Slider
                    label={t(repricingPresets[preset].knob)}
                    value={knob}
                    min={repricingPresets[preset].min}
                    max={repricingPresets[preset].max}
                    onValueChange={(next) => edit(() => setKnob(next))}
                  />
                  {preset === "slow-stock" ? (
                    <Slider
                      label={editorCopy("age")}
                      value={age}
                      min={14}
                      max={180}
                      onValueChange={(next) => edit(() => setAge(next))}
                    />
                  ) : null}
                  {facts.listingCurrencyCodes.length ? (
                    <Select
                      label={editorCopy("currency")}
                      placeholder={editorCopy("choose")}
                      items={facts.listingCurrencyCodes.map((code) => ({ value: code, label: code }))}
                      value={currency}
                      onValueChange={(next) => edit(() => setCurrency(next))}
                    />
                  ) : (
                    <TextInput
                      label={editorCopy("currency")}
                      description={editorCopy("currency.empty")}
                      value={currency}
                      onChange={(e) => {
                        const next = e.currentTarget.value;
                        edit(() => setCurrency(next));
                      }}
                    />
                  )}
                  <PolicyFloorFields value={floor} onChange={(next) => edit(() => setFloor(next))} />
                  <Button
                    tone="secondary"
                    disabled={!promptComplete}
                    onClick={() => {
                      const opened = openRepricingPreset(candidate);
                      setBody(opened.body);
                      setTier(opened.tier);
                    }}
                  >
                    {editorCopy("openUp")}
                  </Button>
                </>
              ) : (
                <>
                  <TextInput
                    label={editorCopy("excluded")}
                    value={candidate.excludedListingIds?.join(",") ?? ""}
                    onChange={(e) =>
                      changeBody({
                        ...candidate,
                        excludedListingIds: e.currentTarget.value === "" ? [] : e.currentTarget.value.split(","),
                      })
                    }
                  />
                  <PolicyNumber
                    label={editorCopy("cap")}
                    value={candidate.maxChangesPerDay}
                    onChange={(maxChangesPerDay) => changeBody({ ...candidate, maxChangesPerDay })}
                  />
                  {tier === "structured" ? (
                    <Button tone="secondary" onClick={() => setTier("advanced")}>
                      {editorCopy("openAdvanced")}
                    </Button>
                  ) : (
                    <Text>{editorCopy("firstMatch")}</Text>
                  )}
                  {candidate.rules.map((rule, index) => (
                    <Fieldset
                      key={index}
                      legend={
                        index === candidate.rules.length - 1
                          ? editorCopy("defaultRule")
                          : t("pricing.features.repricingPolicies.ui.editor.rule.number", { number: index + 1 })
                      }
                    >
                      <Stack gap={4}>
                        {tier === "advanced" && index !== candidate.rules.length - 1 ? (
                          <>
                            {rule.conditions.map((condition, conditionIndex) => (
                              <Stack key={conditionIndex} gap={2}>
                                <Select
                                  label={editorCopy("condition")}
                                  items={controlItems(policyControls.condition)}
                                  value={condition.type}
                                  onValueChange={(type) =>
                                    changeBody({
                                      ...candidate,
                                      rules: candidate.rules.map((r, i) =>
                                        i === index
                                          ? {
                                              ...r,
                                              conditions: r.conditions.map((c, j) =>
                                                j === conditionIndex
                                                  ? newPolicyCondition(type as RepricingRuleCondition["type"])
                                                  : c,
                                              ),
                                            }
                                          : r,
                                      ),
                                    })
                                  }
                                />
                                <PolicyConditionFields
                                  value={condition}
                                  categories={categories}
                                  onChange={(next) =>
                                    changeBody({
                                      ...candidate,
                                      rules: candidate.rules.map((r, i) =>
                                        i === index
                                          ? {
                                              ...r,
                                              conditions: r.conditions.map((c, j) => (j === conditionIndex ? next : c)),
                                            }
                                          : r,
                                      ),
                                    })
                                  }
                                />
                                <Button
                                  tone="ghost"
                                  onClick={() =>
                                    changeBody({
                                      ...candidate,
                                      rules: candidate.rules.map((r, i) =>
                                        i === index
                                          ? { ...r, conditions: r.conditions.filter((_, j) => j !== conditionIndex) }
                                          : r,
                                      ),
                                    })
                                  }
                                >
                                  {editorCopy("removeCondition")}
                                </Button>
                              </Stack>
                            ))}
                            <Button
                              tone="secondary"
                              onClick={() =>
                                changeBody({
                                  ...candidate,
                                  rules: candidate.rules.map((r, i) =>
                                    i === index
                                      ? { ...r, conditions: [...r.conditions, newPolicyCondition("category")] }
                                      : r,
                                  ),
                                })
                              }
                            >
                              {editorCopy("addCondition")}
                            </Button>
                            <Stack direction="row" gap={2}>
                              <Button
                                tone="ghost"
                                disabled={index === 0}
                                onClick={() => {
                                  const rules = [...candidate.rules];
                                  [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!];
                                  changeBody({ ...candidate, rules });
                                }}
                              >
                                {editorCopy("moveUp")}
                              </Button>
                              <Button
                                tone="ghost"
                                onClick={() =>
                                  changeBody({ ...candidate, rules: candidate.rules.filter((_, i) => i !== index) })
                                }
                              >
                                {editorCopy("removeRule")}
                              </Button>
                            </Stack>
                          </>
                        ) : null}
                        <PolicyDirectiveFields
                          value={rule.directive}
                          advanced={tier === "advanced"}
                          onChange={(directive) =>
                            changeBody({
                              ...candidate,
                              rules: candidate.rules.map((r, i) => (i === index ? { ...r, directive } : r)),
                            })
                          }
                        />
                      </Stack>
                    </Fieldset>
                  ))}
                  {tier === "advanced" ? (
                    <Button
                      tone="secondary"
                      onClick={() => {
                        const last = candidate.rules.at(-1)!;
                        changeBody({
                          ...candidate,
                          rules: [
                            ...candidate.rules.slice(0, -1),
                            { ...last, conditions: [newPolicyCondition("category")] },
                            last,
                          ],
                        });
                      }}
                    >
                      {editorCopy("addRule")}
                    </Button>
                  ) : null}
                </>
              )}
            </Stack>
          </Fieldset>
        ) : null}
        {facts ? (
          <ScopePreviewPanel
            api={api}
            input={{
              scope: candidate.scope,
              excludedListingIds: candidate.excludedListingIds,
              ...(policyId ? { replacingPolicyId: policyId } : {}),
            }}
          />
        ) : null}
        {streamFailed ? <Banner tone="warning" title={editorCopy("preview.reconnecting")} /> : null}
        {binding ? (
          <DryRunResult
            run={binding.run}
            traces={traces}
            samplesLoading={samplesLoading}
            samplesFailed={samplesFailed}
            onNext={(after) => {
              void loadSamples(after);
            }}
          />
        ) : null}
      </Stack>
    </SideSheet>
  );
}
