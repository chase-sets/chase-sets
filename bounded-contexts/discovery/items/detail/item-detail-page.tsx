import { useEffect, useState } from "react";
import {
  Breadcrumbs,
  ImageGallery,
  KeyValueList,
  DetailPanel,
  Banner,
  Reveal,
  Stack,
  Stagger,
  Text,
  PageHeader,
  PageSection,
} from "@chase-sets/design-system";
import { Badge } from "@chase-sets/design-system";
import type { DiscoveryItemDetail } from "../client-support/contracts";
import { VersionSelector } from "./version-selector";

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

export function ItemDetailPage({
  data,
  notFound = false,
  error = null,
}: {
  data: DiscoveryItemDetail | null;
  notFound?: boolean;
  error?: string | null;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!data?.version_schema) {
      setSelections({});
      return;
    }

    const initial: Record<string, string> = {};
    for (const dim of data.version_schema.dimensions) {
      if (dim.allowedChoices.length > 0) {
        initial[dim.dimensionId] = dim.allowedChoices[0].choiceId;
      }
    }
    setSelections(initial);
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

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "/search" },
          { label: data.title },
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Stack gap={6}>
          <Reveal preset="lift">
            {images.length > 0 ? (
              <ImageGallery images={images} />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-muted bg-background">
                <Text tone="secondary">No images available</Text>
              </div>
            )}
          </Reveal>

          <Reveal preset="lift">
            <PageHeader title={data.title} description={data.subtitle} />
          </Reveal>

          {data.description ? (
            <Reveal preset="lift">
              <PageSection title="Description">
                <Text>{data.description}</Text>
              </PageSection>
            </Reveal>
          ) : null}

          {data.version_schema && data.version_schema.dimensions.length > 0 ? (
            <Reveal preset="lift">
              <PageSection title="Version">
                <VersionSelector
                  schema={data.version_schema}
                  selections={selections}
                  onSelectionChange={(dimensionId, choiceId) =>
                    setSelections((current) => ({
                      ...current,
                      [dimensionId]: choiceId,
                    }))
                  }
                />
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

        <Reveal preset="slideRight">
          <DetailPanel title="Info">
            <Stack gap={3}>
              {data.blueprint ? (
                <div>
                  <Text size="sm" weight="semibold">
                    Blueprint
                  </Text>
                  <Text size="sm" tone="secondary">
                    {data.blueprint.name}
                  </Text>
                </div>
              ) : null}

              {data.categories.length > 0 ? (
                <div>
                  <Text size="sm" weight="semibold">
                    Categories
                  </Text>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.categories.map((category) => (
                      <Badge key={category.categoryId} tone="accent">
                        {category.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {data.tags.length > 0 ? (
                <div>
                  <Text size="sm" weight="semibold">
                    Tags
                  </Text>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <div>
                <Text size="sm" weight="semibold">
                  Last Updated
                </Text>
                <Text size="sm" tone="secondary">
                  {data.updated_at}
                </Text>
              </div>
            </Stack>
          </DetailPanel>
        </Reveal>
      </div>
    </Stagger>
  );
}
