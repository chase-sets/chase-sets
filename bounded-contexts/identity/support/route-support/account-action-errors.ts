import { t } from "@chase-sets/localization";
import { data } from "react-router";
import type { FormActionContext } from "@chase-sets/platform-runtime/http";
import { identityApiErrorAdapter } from "../request-support/route-api-error";

type ExpectedAccountActionError =
  | Readonly<{ kind: "validation"; status: 400 | 422; code: "validation_failed" | "validation_error" }>
  | Readonly<{ kind: "domain"; status: 404; code: "not_found" }>
  | Readonly<{ kind: "domain"; status: 409; code: "conflict" }>;

export type AccountActionFailureResult = Readonly<{
  failure: ExpectedAccountActionError & Readonly<{ message: string; intent: string }>;
}>;

export function createAccountActionErrorHandling() {
  const committed = new WeakSet<FormActionContext>();

  function onApiError(error: unknown, context: FormActionContext) {
    if (committed.has(context)) throw error;

    const status = identityApiErrorAdapter.getStatus(error);
    const code = identityApiErrorAdapter.getErrorCode(error);
    let failure: ExpectedAccountActionError;
    let message: string;
    if ((status === 400 || status === 422) && (code === "validation_failed" || code === "validation_error")) {
      failure = { kind: "validation", status, code };
      message = t("identity.support.routeSupport.accountActionErrors.validation");
    } else if (status === 404 && code === "not_found") {
      failure = { kind: "domain", status, code };
      message = t("identity.support.routeSupport.accountActionErrors.notFound");
    } else if (status === 409 && code === "conflict") {
      failure = { kind: "domain", status, code };
      message = t("identity.support.routeSupport.accountActionErrors.conflict");
    } else {
      throw error;
    }

    return data({ failure: { ...failure, message, intent: context.intent } } satisfies AccountActionFailureResult, {
      status: failure.status,
    });
  }

  return {
    options: { errorAdapter: identityApiErrorAdapter, onApiError },
    markCommitted: (context: FormActionContext) => {
      committed.add(context);
    },
  };
}
