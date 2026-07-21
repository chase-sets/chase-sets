import type { HelpArticle } from "../domain/article-model";
import { resolveArticlePolicyValues } from "../domain/resolve-article-policy-values";
import { loadPublicPolicyValues } from "./public-policy-values-client";

export async function resolvePublicPolicyArticle(
  request: Request,
  article: HelpArticle,
  route: string,
): Promise<HelpArticle> {
  try {
    const policyValues = await loadPublicPolicyValues(request);
    const unresolvedKeys = article.policyValueKeys.filter((key) => !policyValues.values[key]);
    if (unresolvedKeys.length > 0) {
      const degradedArticle = resolveArticlePolicyValues(article, policyValues, { unavailableKeys: unresolvedKeys });
      logUnavailablePolicyValues(route, unresolvedKeys, "missing-policy-values");
      return degradedArticle;
    }
    return resolveArticlePolicyValues(article, policyValues);
  } catch (error) {
    logUnavailablePolicyValues(route, article.policyValueKeys, error);
    return resolveArticlePolicyValues(
      article,
      {
        values: {},
        resolvedAt: new Date().toISOString(),
        propagationSeconds: 0,
        changeCalloutDays: 0,
      },
      { unavailableKeys: article.policyValueKeys },
    );
  }
}

function logUnavailablePolicyValues(route: string, unresolvedKeys: readonly string[], error: unknown) {
  console.error("[public-presence] Public policy values are unavailable.", {
    event: "public-policy-values.unavailable",
    route,
    unresolvedKeys: [...new Set(unresolvedKeys)].sort(),
    error: error instanceof Error ? error.message : String(error),
  });
}
