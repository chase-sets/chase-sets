import { t } from "@chase-sets/localization";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { OperationsAttentionQueuePage } from "../../features/operations-attention-queue/ui/operations-attention-queue-page";
import { loadOperationsAttentionQueue } from "../../support/request-support/operations-attention-queue-client";

const routeKey = "platformOperations.operationsAttention";

// The shared realtime topic the operations attention surface rides for its
// live/stale connection indicator.
const OPERATIONS_ATTENTION_REALTIME_TOPICS = ["platform-operations:admin:operations-attention"] as const;

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const queue = await loadOperationsAttentionQueue(request, actor?.permissions ?? []);
  return { queue };
}

export default function OperationsAttentionRoute() {
  const { queue } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  return (
    <OperationsAttentionQueuePage
      queue={queue}
      realtimeTopics={OPERATIONS_ATTENTION_REALTIME_TOPICS}
      onRefresh={revalidator.revalidate}
    />
  );
}
