import { useState } from "react";
import {
  Avatar,
  Badge,
  Breadcrumbs,
  Button,
  Caption,
  Card,
  CheckoutLayout,
  Combobox,
  ConditionBadge,
  DateInput,
  FilterBar,
  FilterDrawer,
  FormSection,
  Grid,
  Heading,
  IconButton,
  Inline,
  LinkButton,
  LinkText,
  MarketplaceShell,
  OrderSummary,
  PageHeader,
  PageSection,
  PageStepper,
  Pagination,
  Popover,
  PriceDisplay,
  RadioGroup,
  SearchInput,
  SearchResultsLayout,
  Select,
  SellerBadge,
  Stack,
  StatusPill,
  Surface,
  Tag,
  Text,
  TextInput,
  Thumbnail,
  Tooltip
} from "@chase-sets/design-system";
import { inventoryRows, marketplaceNav } from "../fixtures";

export function MarketplaceView() {
  const [cartPage, setCartPage] = useState(3);
  const [selectedSet, setSelectedSet] = useState<string | undefined>();

  return (
    <MarketplaceShell
      brand={<SellerBadge name="Chase Sets" verified />}
      topNavItems={marketplaceNav}
      bottomNavItems={marketplaceNav}
      activeKey="browse"
      actions={
        <Inline gap={2}>
          <Tooltip content="View your saved want lists">
            <IconButton label="Saved wants" icon="spark" />
          </Tooltip>
          <LinkButton href="#sell" tone="secondary">
            Sell cards
          </LinkButton>
        </Inline>
      }
      hero={
        <Surface elevated>
          <PageHeader
            eyebrow="Marketplace"
            title="Build a complete set without fighting the interface"
            description="Responsive search, transparent pricing, and buyer-first cart building are all composed from design-system primitives."
            actions={
              <>
                <Button>Start browsing</Button>
                <Button tone="secondary">View saved wants</Button>
              </>
            }
          />
        </Surface>
      }
      sidebar={
        <Stack gap={4}>
          <Surface>
            <Heading level={4}>Quick Filters</Heading>
            <Text tone="secondary">
              Card type, rarity, price band, condition, and seller trust all fit
              into the same primitive stack.
            </Text>
            <Inline gap={2}>
              <Tag tone="accent" onRemove={() => {}}>
                Modern
              </Tag>
              <Tag tone="success" onRemove={() => {}}>
                Verified
              </Tag>
              <Badge tone="info">Ships fast</Badge>
            </Inline>
          </Surface>
          <Surface>
            <Heading level={5}>Top Sellers</Heading>
            <Stack gap={3}>
              <Inline gap={2}>
                <Avatar name="North Side Cards" size="sm" />
                <Stack gap={0}>
                  <Text size="sm" weight="semibold">
                    North Side Cards
                  </Text>
                  <Caption>4.9 stars - 2,400 sales</Caption>
                </Stack>
              </Inline>
              <Inline gap={2}>
                <Avatar name="Gem Mint TCG" size="sm" />
                <Stack gap={0}>
                  <Text size="sm" weight="semibold">
                    Gem Mint TCG
                  </Text>
                  <Caption>4.8 stars - 1,800 sales</Caption>
                </Stack>
              </Inline>
            </Stack>
          </Surface>
          <Surface>
            <Heading level={5}>Browse by Set</Heading>
            <Combobox
              label="Set"
              hideLabel
              items={[
                { value: "sv8", label: "Surging Sparks" },
                { value: "sv7", label: "Stellar Crown" },
                { value: "sv6", label: "Twilight Masquerade" },
                { value: "sv5", label: "Temporal Forces" }
              ]}
              value={selectedSet}
              onValueChange={setSelectedSet}
              placeholder="Search sets..."
            />
          </Surface>
        </Stack>
      }
    >
      <PageSection
        title="Search Results"
        description="Every result card is built from library exports only."
      >
        <Breadcrumbs
          items={[
            { label: "Home", href: "#" },
            { label: "Pokemon TCG", href: "#" },
            { label: "Surging Sparks" }
          ]}
        />
        <FilterBar
          actions={
            <>
              <FilterDrawer trigger={<Button tone="secondary">Filters</Button>}>
                <Select
                  label="Condition"
                  items={[
                    { value: "nm", label: "Near mint" },
                    { value: "lp", label: "Light play" },
                    { value: "mp", label: "Moderate play" }
                  ]}
                />
                <Select
                  label="Seller rating"
                  items={[
                    { value: "all", label: "All sellers" },
                    { value: "trusted", label: "Trusted only" }
                  ]}
                />
              </FilterDrawer>
              <Popover
                trigger={<Button tone="ghost">Sort</Button>}
                title="Sort listings"
              >
                <RadioGroup
                  label="Sort order"
                  hideLabel
                  items={[
                    { value: "price-asc", label: "Price: low to high" },
                    { value: "price-desc", label: "Price: high to low" },
                    { value: "recent", label: "Recently listed" }
                  ]}
                  defaultValue="price-asc"
                />
              </Popover>
            </>
          }
        >
          <SearchInput
            label="Find cards"
            placeholder="Search card, set, or variant"
          />
          <Select
            label="Rarity"
            items={[
              { value: "all", label: "All rarities" },
              { value: "rare", label: "Rare+" },
              { value: "common", label: "Common to uncommon" }
            ]}
          />
        </FilterBar>
        <SearchResultsLayout
          summary={
            <Inline gap={3} align="center">
              <Text tone="secondary">
                428 matching listings across 36 sellers with consolidated shipping.
              </Text>
              <StatusPill tone="success">Live</StatusPill>
            </Inline>
          }
        >
          <Grid columns={{ base: 1, sm: 2, lg: 3, xl: 4 }} gap={3}>
            {inventoryRows.map((row) => (
              <Card key={row.sku}>
                <Thumbnail alt={row.card} ratio={1} />
                <Stack gap={3}>
                  <Inline gap={2}>
                    <ConditionBadge condition={row.condition} />
                    <Badge tone="success">In stock</Badge>
                  </Inline>
                  <Heading level={5}>{row.card}</Heading>
                  <Inline gap={2}>
                    <Avatar name="North Side Cards" size="sm" />
                    <LinkText href="#">North Side Cards</LinkText>
                  </Inline>
                  <Inline gap={3}>
                    <PriceDisplay amount={row.price} />
                    <Text size="sm" tone="secondary">
                      {row.stock} available
                    </Text>
                  </Inline>
                  <Tooltip content="Add this card to your cart">
                    <Button block>Add to cart</Button>
                  </Tooltip>
                </Stack>
              </Card>
            ))}
          </Grid>
        </SearchResultsLayout>
        <Pagination page={cartPage} totalPages={48} onPageChange={setCartPage} />
      </PageSection>

      <PageSection title="Checkout Flow">
        <PageStepper
          items={[
            {
              label: "Cart review",
              description: "Verify items and quantities",
              status: "complete"
            },
            {
              label: "Shipping",
              description: "Choose delivery method",
              status: "current"
            },
            {
              label: "Payment",
              description: "Secure checkout",
              status: "upcoming"
            }
          ]}
        />
        <CheckoutLayout
          summary={
            <OrderSummary
              lines={[
                { label: "Cards (3)", value: "$51.70" },
                { label: "Shipping", value: "$4.25" },
                { label: "Rebate", value: "-$1.15" }
              ]}
              total="$54.80"
            />
          }
        >
          <FormSection
            title="Shipping Details"
            description="Where should we send your cards?"
          >
            <TextInput label="Full name" defaultValue="Todd S." />
            <TextInput label="Address" placeholder="123 Main St" />
            <Inline gap={3}>
              <TextInput label="City" placeholder="Chicago" />
              <TextInput label="ZIP" placeholder="60601" />
            </Inline>
            <DateInput label="Preferred delivery date" />
          </FormSection>
        </CheckoutLayout>
      </PageSection>
    </MarketplaceShell>
  );
}
