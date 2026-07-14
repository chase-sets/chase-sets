import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { t } from "@chase-sets/localization";
import {
  CollectionsApiError,
  type SavedListDestination,
  type SavedListDiscoverySurface,
  type SavedListProductSelection,
} from "@chase-sets/collections/server";
import {
  appendAnonymousSavedListCookie,
  createCollectionsRequestApiClient,
  createSavedListAdditionTokens,
  ensureAnonymousSavedListOwnerId,
  readAnonymousSavedListOwnerId,
} from "@chase-sets/collections/server";
import type {
  SavedListClaimLoadState,
  SavedListPickerPreparation,
  SavedListRouteActionData,
} from "../ui-support/saved-list-contracts";

export async function prepareSavedListAddition(
  input: Readonly<{
    request: Request;
    product: SavedListProductSelection;
    productLabel: string;
    sourceSurface: SavedListDiscoverySurface;
  }>,
) {
  const api = createCollectionsRequestApiClient(input.request);
  const actor = await resolveActorFromAuthApi({ request: input.request });
  if (actor) {
    const recent = await api.listRecentSavedLists();
    return Response.json({
      status: "ready",
      preparation: {
        product: input.product,
        productLabel: input.productLabel,
        recentLists: recent.items,
        tokens: createSavedListAdditionTokens(),
        sourceSurface: input.sourceSurface,
        claimIntentId: null,
        resumeDestination: null,
        resumeTrackedQuantity: null,
      },
    } satisfies SavedListRouteActionData);
  }

  const anonymousOwnerId = ensureAnonymousSavedListOwnerId(input.request);
  const sourcePath = cleanSourcePath(input.request);
  const created = await api.createAnonymousSavedListIntent(anonymousOwnerId, {
    sourcePath,
    sourceSurface: input.sourceSurface,
    product: input.product,
    productSummary: input.productLabel,
  });
  const returnUrl = new URL(sourcePath, new URL(input.request.url).origin);
  returnUrl.searchParams.set("claimSavedListIntent", created.intent.intentId);
  const response = Response.json({
    status: "registration-required",
    href: `/register?returnTo=${encodeURIComponent(`${returnUrl.pathname}${returnUrl.search}`)}`,
  } satisfies SavedListRouteActionData);
  appendAnonymousSavedListCookie(response.headers, anonymousOwnerId, input.request);
  return response;
}

export async function commitSavedListAddition(request: Request, formData: FormData) {
  const api = createCollectionsRequestApiClient(request);
  const preparation = parsePreparation(formData.get("preparation"));
  const destination = parseDestination(formData, preparation);
  const trackedQuantity = Number(formData.get("trackedQuantity"));
  try {
    const result = preparation.claimIntentId
      ? await api.claimAnonymousSavedListIntent(requireAnonymousOwnerId(request), preparation.claimIntentId, {
          destination,
          trackedQuantity,
          sourceSurface: preparation.sourceSurface,
        })
      : await api.addProductToSavedList({
          destination,
          addCommandId: preparation.tokens.addCommandId,
          lineId: preparation.tokens.lineId,
          product: preparation.product,
          trackedQuantity,
          sourceSurface: preparation.sourceSurface,
        });
    return Response.json({ status: "saved", result, trackedQuantity } satisfies SavedListRouteActionData);
  } catch (error) {
    return savedListActionError(error);
  }
}

export async function loadSavedListClaimPreparation(
  request: Request,
  productLabel: (product: SavedListProductSelection) => string,
): Promise<SavedListClaimLoadState> {
  const intentId = new URL(request.url).searchParams.get("claimSavedListIntent")?.trim() ?? "";
  if (!intentId) return { preparation: null, error: null };
  const actor = await resolveActorFromAuthApi({ request });
  const anonymousOwnerId = readAnonymousSavedListOwnerId(request);
  if (!actor || !anonymousOwnerId) {
    return {
      preparation: null,
      error: t("collections.features.savedLists.api.route.anonymous.owner.required"),
    };
  }
  try {
    const claimed = await createCollectionsRequestApiClient(request).prepareAnonymousSavedListClaim(
      anonymousOwnerId,
      intentId,
    );
    return {
      preparation: {
        product: claimed.intent.product,
        productLabel: claimed.intent.productSummary ?? productLabel(claimed.intent.product),
        recentLists: claimed.recentLists,
        tokens: claimed.tokens,
        sourceSurface: claimed.intent.sourceSurface,
        claimIntentId: claimed.intent.intentId,
        resumeDestination: claimed.resumeDestination,
        resumeTrackedQuantity: claimed.intent.claimedTrackedQuantity,
      },
      error: null,
    };
  } catch (error) {
    return { preparation: null, error: apiErrorMessage(error) };
  }
}

export function savedListActionError(error: unknown) {
  return Response.json(
    { error: apiErrorMessage(error) },
    { status: error instanceof CollectionsApiError ? error.status : 400 },
  );
}

function parsePreparation(value: FormDataEntryValue | null): SavedListPickerPreparation {
  const parsed = JSON.parse(String(value ?? "{}")) as SavedListPickerPreparation;
  if (!parsed.product?.productId || !parsed.tokens?.addCommandId) {
    throw new Error(t("collections.features.savedLists.api.route.request.invalid"));
  }
  return parsed;
}

function parseDestination(formData: FormData, preparation: SavedListPickerPreparation): SavedListDestination {
  if (formData.get("destinationKind") === "new") {
    return {
      kind: "new",
      listId: preparation.tokens.newListId,
      createCommandId: preparation.tokens.newListCommandId,
      title: String(formData.get("newListTitle") ?? ""),
    };
  }
  return { kind: "existing", listId: String(formData.get("listId") ?? "") as SavedListDestination["listId"] };
}

function requireAnonymousOwnerId(request: Request) {
  const ownerId = readAnonymousSavedListOwnerId(request);
  if (!ownerId) throw new Error(t("collections.features.savedLists.api.route.anonymous.owner.required"));
  return ownerId;
}

function cleanSourcePath(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("claimSavedListIntent");
  return `${url.pathname}${url.search}`;
}

function apiErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("collections.features.savedLists.api.route.request.invalid");
}
