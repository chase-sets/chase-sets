import { useEffect, useState } from "react";
import {
  Breadcrumbs,
  Container,
  Grid,
  Heading,
  Icon,
  ImageGallery,
  Inline,
  KeyValueList,
  Banner,
  Reveal,
  SplitPane,
  Stack,
  Stagger,
  Surface,
  Text,
  PageSection,
} from "@chase-sets/design-system";
import { Badge } from "@chase-sets/design-system";
import type {
  DiscoveryItemDetail,
} from "../client-support/contracts";
import { VersionSelector } from "./version-selector";
import {
  normalizeSelectionsForSchema,
  summarizeSelections,
} from "./versioning";

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  return JSON.stringify(value);
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  }).format(date)} UTC`;
}

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
}) {
  const [selections, setSelections] = useState<Record<string, string>>(() =>
    data?.version_schema ? normalizeSelectionsForSchema(data.version_schema, {}) : {},
  );

  useEffect(() => {
    if (!data?.version_schema) {
      setSelections({});
      return;
    }

    setSelections(normalizeSelectionsForSchema(data.version_schema, {}));
  }, [data]);

  if (error) {
    return <Banner tone="danger" title="Error" description={error} />;
  }

  if (!data) {
    return (
      <Banner
        tone="danger"
        title={notFound ? "Not found" : "Error"}
        description={
          notFound
            ? "This item could not be found."
            : "This item is not available right now."
        }
      />
    );
  }

  const images = data.image_urls.map((url, index) => ({
    src: url,
    alt: `${data.title} image ${index + 1}`,
  }));
  const selectedVersion = data.version_schema
    ? summarizeSelections(data.version_schema, selections)
    : [];
  const metadataItems = [
    ...(data.tags.length > 0
      ? [
          {
            key: "Tags",
            value: (
              <Inline gap={1}>
                {data.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    {tag}
                  </Badge>
                ))}
              </Inline>
            ),
          },
        ]
      : []),
    {
      key: "Last Updated",
      value: formatUpdatedAt(data.updated_at),
    },
  ];

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "/search" },
          { label: data.title },
        ]}
      />

      <Container width="wide" paddingX={0}>
        <Reveal preset="lift">
          <SplitPane
            secondarySticky
            secondaryWidth="detail"
            primary={
              <Stack gap={4}>
                <Surface elevated>
                  <Stack gap={5}>
                    <Stack gap={3}>
                      {data.blueprint ? (
                        <Text size="sm" weight="semibold" tone="accent">
                          {data.blueprint.name}
                        </Text>
                      ) : null}

                      <div className="space-y-2">
                        <Heading level={1}>{data.title}</Heading>
                        {data.subtitle ? (
                          <Text size="lg" tone="secondary">
                            {data.subtitle}
                          </Text>
                        ) : null}
                      </div>

                      {data.categories.length > 0 ? (
                        <Inline gap={2}>
                          {data.categories.map((category) => (
                            <Badge key={category.categoryId} tone="accent">
                              {category.name}
                            </Badge>
                          ))}
                        </Inline>
                      ) : null}
                    </Stack>

                    {data.version_schema && data.version_schema.dimensions.length > 0 ? (
                      <div className="space-y-3">
                        <Text size="sm" weight="semibold">
                          Choose Version
                        </Text>
                        <VersionSelector
                          schema={data.version_schema}
                          selections={selections}
                          onSelectionChange={(dimensionId, choiceId) =>
                            setSelections((current) =>
                              normalizeSelectionsForSchema(data.version_schema!, {
                                ...current,
                                [dimensionId]: choiceId,
                              }),
                          )
                        }
                      />
                    </div>
                  ) : null}

                    <Grid columns={{ base: 1, xl: 2 }} gap={4}>
                      {selectedVersion.length > 0 ? (
                        <div className="space-y-2">
                          <Text size="sm" weight="semibold">
                            Selected Version
                          </Text>
                          <KeyValueList
                            items={selectedVersion.map((selection) => ({
                              key: selection.dimensionName,
                              value: selection.choiceLabel,
                            }))}
                          />
                        </div>
                      ) : null}

                      {metadataItems.length > 0 ? (
                        <div className="space-y-2">
                          <Text size="sm" weight="semibold">
                            Item Facts
                          </Text>
                          <KeyValueList items={metadataItems} />
                        </div>
                      ) : null}
                    </Grid>
                  </Stack>
                </Surface>
              </Stack>
            }
            secondary={
              <ImageGallery
                images={images}
                maxHeightClassName="lg:[--gallery-max-height:min(62vh,28rem)]"
                emptyState={
                  <div className="space-y-3 text-center">
                    <div className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full border border-dashed border-muted bg-background">
                      <Icon name="image" size="lg" tone="secondary" />
                    </div>
                    <div className="space-y-1">
                      <Text weight="semibold">Image coming soon</Text>
                      <Text size="sm" tone="secondary">
                        Catalog imagery has not been added yet.
                      </Text>
                    </div>
                  </div>
                }
              />
            }
          />
        </Reveal>
      </Container>

      <Container width="content" paddingX={0}>
        <Stack gap={6}>
          {data.description ? (
            <Reveal preset="lift">
              <PageSection title="Description">
                <Surface>
                  <Text>{data.description}</Text>
                </Surface>
              </PageSection>
            </Reveal>
          ) : null}

          {data.field_values.length > 0 ? (
            <Reveal preset="lift">
              <PageSection title="Details">
                <KeyValueList
                  items={data.field_values.map((fieldValue) => ({
                    key: fieldValue.fieldName,
                    value: formatFieldValue(fieldValue.value),
                  }))}
                />
              </PageSection>
            </Reveal>
          ) : null}
        </Stack>
      </Container>
    </Stagger>
  );
}
