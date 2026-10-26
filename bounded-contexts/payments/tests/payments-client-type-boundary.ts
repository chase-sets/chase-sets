import type { hc, InferResponseType } from "hono/client";
import type { buildPaymentsApi } from "../api";
import type {
  PaymentsCheckoutRecoveryOptions,
  PaymentsCheckoutStatus,
  PaymentsPaymentDetail,
} from "../features/payments/api/contracts";

type PaymentsRouteClient = ReturnType<typeof hc<ReturnType<typeof buildPaymentsApi>>>;
// `any`, `unknown`, and `never` (no reply with the asked status) would each pass the assignments below.
type IsConcrete<T> = [T] extends [never] ? false : 0 extends 1 & T ? false : unknown extends T ? false : true;

declare const client: PaymentsRouteClient;

// @ts-expect-error The payments API registers no `paymnts` path.
void client.account.paymnts.$post({ json: { orderIds: ["ord_1"] } });
// @ts-expect-error `/account/payments` registers POST, not DELETE.
void client.account.payments.$delete();
// @ts-expect-error `/account/payments/:id` needs its `id` path param.
void client.account.payments[":id"].$get({});
// @ts-expect-error A payment start sends order IDs as a string list.
void client.account.payments.$post({ json: { orderIds: 1 } });

declare const createdPayment: InferResponseType<PaymentsRouteClient["account"]["payments"]["$post"], 201>;
declare const accountPayment: InferResponseType<PaymentsRouteClient["account"]["payments"][":id"]["$get"], 200>;
declare const recoveredPayment: InferResponseType<PaymentsRouteClient["account"]["checkout"]["recover"]["$post"], 201>;
declare const checkoutStatus: InferResponseType<PaymentsRouteClient["account"]["checkout"]["status"]["$get"], 200>;
declare const previewStatus: InferResponseType<
  PaymentsRouteClient["account"]["checkout"]["preview-status"]["$get"],
  200
>;
declare const recoveryOptions: InferResponseType<PaymentsRouteClient["account"]["checkout"]["recovery"]["$get"], 200>;

const concrete: readonly true[] = [
  true satisfies IsConcrete<typeof createdPayment>,
  true satisfies IsConcrete<typeof accountPayment>,
  true satisfies IsConcrete<typeof recoveredPayment>,
  true satisfies IsConcrete<typeof checkoutStatus>,
  true satisfies IsConcrete<typeof previewStatus>,
  true satisfies IsConcrete<typeof recoveryOptions>,
];
const decodedPayments: readonly PaymentsPaymentDetail[] = [createdPayment, accountPayment, recoveredPayment];
const decodedStatuses: readonly PaymentsCheckoutStatus[] = [checkoutStatus, previewStatus];
const decodedRecovery: PaymentsCheckoutRecoveryOptions = recoveryOptions;
void [concrete, decodedPayments, decodedStatuses, decodedRecovery];
