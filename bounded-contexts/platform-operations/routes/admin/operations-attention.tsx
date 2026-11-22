import { t } from "@chase-sets/localization";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { OperationsAttentionQueuePage } from "../../features/operations-attention-queue/ui/operations-attention-queue-page";
import { OPERATIONS_ATTENTION_REALTIME_TOPIC } from "../../features/operations-attention-queue/api/realtime-topics";
import { loadOperationsAttentionQueue } from "../../support/request-support/operations-attention-queue-client";

const routeKey = "platformOperations.operationsAttention";

// Platform Operations publishes to this topic whenever a queue source it
// projects changes; the page reloads the queue on each patch.
const OPERATIONS_ATTENTION_REALTIME_TOPICS = [OPERATIONS_ATTENTION_REALTIME_TOPIC] as const;

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.metaTitle`) }];

export async function loader({ request }: LoaderFunctionArgs) {
  const queue = await loadOperationsAttentionQueue(request);
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
