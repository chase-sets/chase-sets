import { t } from "@chase-sets/localization";
import {
  AdminResourceListPage,
  Badge,
  CopyButton,
  EvidenceCodeBlock,
  Heading,
  Inline,
  LinkButton,
  List,
  Stack,
  Text,
  type DataColumn,
} from "@chase-sets/design-system";
import type { ListResponse } from "@chase-sets/http/responses";
import { formatDateTime } from "@chase-sets/localization";
import type { AgentGrant } from "./contracts";
import { agentGrantSpendSummary, agentGrantStatusTone } from "./agent-grant-presentation";
import { agentGrantStatusLabel, authDateUnavailable } from "../../../support/ui-support/value-labels";

type AgentGrantListResponse = ListResponse<AgentGrant> & Partial<Readonly<{ limit: number; offset: number }>>;

// There is no marketplace-hosted developer-docs page yet (lands with m115's public docs KB);
// link at the public UCP specification overview in the meantime.
export const AGENT_CONNECT_DEVELOPER_DOCS_HREF = "https://ucp.dev/latest/specification/overview";

function clientLabel(grant: AgentGrant) {
  return grant.client_name ?? grant.client_uri ?? grant.platform_profile_url;
}

const columns: DataColumn<AgentGrant>[] = [
  {
    key: "client",
    header: t("auth.features.agentGrants.ui.agentGrantListPage.agent"),
    cell: (row) => (
      <Stack gap={0}>
        <Text weight="semibold">{clientLabel(row)}</Text>
        <Badge tone={agentGrantStatusTone(row.status)}>{agentGrantStatusLabel(row.status)}</Badge>
      </Stack>
    ),
  },
  {
    key: "scopes",
    header: t("auth.features.agentGrants.ui.agentGrantListPage.scopes"),
    cell: (row) => t("auth.features.agentGrants.ui.agentGrantListPage.scope.count", { count: row.scopes.length }),
  },
  {
    key: "spend",
    header: t("auth.features.agentGrants.ui.agentGrantListPage.spend"),
    cell: (row) => agentGrantSpendSummary(row),
  },
  {
    key: "granted_at",
    header: t("auth.features.agentGrants.ui.agentGrantListPage.granted"),
    cell: (row) => formatDateTime(row.granted_at, { preset: "short", fallback: authDateUnavailable() }),
  },
];

function listPagination(data: AgentGrantListResponse) {
  return typeof data.limit === "number" && typeof data.offset === "number"
    ? { limit: data.limit, offset: data.offset, total: data.total }
    : undefined;
}

// Static per-platform walkthroughs. There is no marketplace-hosted
// developer-docs page yet (that lands with m115's public docs KB), so "learn more" points at
// the public UCP specification in the meantime.
function connectPlatformSteps(mcpUrl: string) {
  return [
    {
      key: "claude",
      name: t("auth.features.agentGrants.ui.agentGrantListPage.connect.claude.name"),
      steps: [
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.claude.step1"),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.claude.step2", { url: mcpUrl }),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.claude.step3"),
      ],
    },
    {
      key: "chatgpt",
      name: t("auth.features.agentGrants.ui.agentGrantListPage.connect.chatgpt.name"),
      steps: [
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.chatgpt.step1"),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.chatgpt.step2", { url: mcpUrl }),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.chatgpt.step3"),
      ],
    },
    {
      key: "gemini",
      name: t("auth.features.agentGrants.ui.agentGrantListPage.connect.gemini.name"),
      steps: [
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.gemini.step1"),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.gemini.step2", { url: mcpUrl }),
        t("auth.features.agentGrants.ui.agentGrantListPage.connect.gemini.step3"),
      ],
    },
  ];
}

function ConnectInstructions({ mcpUrl, developerDocsHref }: { mcpUrl: string; developerDocsHref: string }) {
  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <Heading level={2}>{t("auth.features.agentGrants.ui.agentGrantListPage.connect.title")}</Heading>
        <Text tone="secondary">{t("auth.features.agentGrants.ui.agentGrantListPage.connect.description")}</Text>
      </Stack>
      <EvidenceCodeBlock label={t("auth.features.agentGrants.ui.agentGrantListPage.connect.url.label")}>
        {mcpUrl}
      </EvidenceCodeBlock>
      <Inline gap={2}>
        <CopyButton
          value={mcpUrl}
          label={t("auth.features.agentGrants.ui.agentGrantListPage.connect.copy")}
          copiedLabel={t("auth.features.agentGrants.ui.agentGrantListPage.connect.copied")}
        />
        <LinkButton href={developerDocsHref} tone="secondary" target="_blank" rel="noreferrer">
          {t("auth.features.agentGrants.ui.agentGrantListPage.connect.learn.more")}
        </LinkButton>
      </Inline>
      <Stack gap={4}>
        {connectPlatformSteps(mcpUrl).map((platform) => (
          <Stack key={platform.key} gap={1}>
            <Text weight="semibold">{platform.name}</Text>
            <List ordered items={platform.steps} />
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

export function AgentGrantListPage({
  hrefBase = "/account/agents",
  initialData,
  mcpUrl,
  developerDocsHref = AGENT_CONNECT_DEVELOPER_DOCS_HREF,
}: {
  hrefBase?: string;
  initialData: AgentGrantListResponse;
  mcpUrl: string;
  developerDocsHref?: string;
}) {
  return (
    <AdminResourceListPage
      title={t("auth.features.agentGrants.ui.agentGrantListPage.connected.agents")}
      items={initialData.items}
      columns={columns}
      emptyMessage={t("auth.features.agentGrants.ui.agentGrantListPage.no.agents.yet")}
      getHref={(row) => `${hrefBase}/${row.id}`}
      filters={<ConnectInstructions mcpUrl={mcpUrl} developerDocsHref={developerDocsHref} />}
      pagination={listPagination(initialData)}
    />
  );
}
