import { useState, useEffect } from "react";
import {
  Breadcrumbs,
  ImageGallery,
  KeyValueList,
  DetailPanel,
  LoadingSpinner,
  Banner,
  Reveal,
  Stack,
  Stagger,
  Text,
  PageHeader,
  PageSection,
} from "@chase-sets/design-system";
import { Badge } from "@chase-sets/design-system";
import { discoveryApi } from "../../shared/ui/api/client";
import type { DiscoveryItemDetail } from "../../shared/ui/api/types";
import { VersionSelector } from "./version-selector";
import { useFetch } from "../../shared/ui/use-fetch";

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "\u2014";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function ItemDetailPage({ id }: { id: string }) {
  const { data, loading, error } = useFetch<DiscoveryItemDetail>(
    () => discoveryApi.get(`/marketplace/items/${id}`),
    [id],
  );

  const [selections, setSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data?.version_schema) {
      const initial: Record<string, string> = {};
      for (const dim of data.version_schema.dimensions) {
        if (dim.allowedChoices.length > 0) {
          initial[dim.dimensionId] = dim.allowedChoices[0].choiceId;
        }
      }
      setSelections(initial);
    }
  }, [data]);

  if (loading) {
    return <LoadingSpinner label="Loading item..." />;
  }

  if (error) {
    return <Banner tone="danger" title="Error" description={error} />;
  }

  if (!data) {
    return <Banner tone="danger" title="Not found" description="This item could not be found." />;
  }

  const images = data.image_urls.map((url, i) => ({
    src: url,
    alt: `${data.title} image ${i + 1}`,
  }));

  return (
    <Stagger>
      <Breadcrumbs
        items={[
          { label: "Search", href: "#/search" },
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
            <PageHeader
              title={data.title}
              description={data.subtitle}
            />
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
                  onSelectionChange={(dimId, choiceId) =>
                    setSelections((prev) => ({ ...prev, [dimId]: choiceId }))
                  }
                />
              </PageSection>
            </Reveal>
          ) : null}

          {data.field_values.length > 0 ? (
            <Reveal preset="lift">
              <PageSection title="Details">
                <KeyValueList
                  items={data.field_values.map((fv) => ({
                    key: fv.fieldName,
                    value: formatFieldValue(fv.value),
                  }))}
                />
              </PageSection>
            </Reveal>
          ) : null}
        </Stack>

        <Reveal preset="slideRight">
          <DetailPanel title="Info">
            <Stack gap={3}>
              {data.blueprint && (
                <div>
                  <Text size="sm" weight="semibold">Blueprint</Text>
                  <Text size="sm" tone="secondary">{data.blueprint.name}</Text>
                </div>
              )}

              {data.categories.length > 0 && (
                <div>
                  <Text size="sm" weight="semibold">Categories</Text>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.categories.map((cat) => (
                      <Badge key={cat.categoryId} tone="accent">{cat.name}</Badge>
                    ))}
                  </div>
                </div>
              )}

              {data.tags.length > 0 && (
                <div>
                  <Text size="sm" weight="semibold">Tags</Text>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.tags.map((tag) => (
                      <Badge key={tag} tone="neutral">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <Text size="sm" weight="semibold">Last Updated</Text>
                <Text size="sm" tone="secondary">{data.updated_at}</Text>
              </div>
            </Stack>
          </DetailPanel>
        </Reveal>
      </div>
    </Stagger>
  );
}

