import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import { ItemDetailPage } from "../../../../bounded-contexts/discovery/items/detail/item-detail-page";
import { createMarketplaceServerApiClient } from "../api.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const api = createMarketplaceServerApiClient(request);
  const id = params.id;

  if (!id) {
    return {
      item: null,
      notFound: true,
    };
  }

  try {
    const item = await api.getItemDetail(id);
    return {
      item,
      notFound: false,
    };
  } catch (error) {
    return {
      item: null,
      notFound: true,
      error: error instanceof Error ? error.message : "Item not found.",
    };
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const title = data?.item
    ? `${data.item.title} | Marketplace`
    : "Item Not Found | Marketplace";

  const description = data?.item?.description
    ? data.item.description
    : "View marketplace item details for Chase Sets.";

  return [
    { title },
    { name: "description", content: description },
  ];
};

export default function MarketplaceItemDetailRoute() {
  const data = useLoaderData<typeof loader>();

  return (
    <ItemDetailPage
      data={data.item}
      notFound={data.notFound}
      error={data.error}
    />
  );
}
