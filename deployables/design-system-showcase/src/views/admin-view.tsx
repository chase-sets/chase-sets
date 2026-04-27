import {
  ActivityList,
  AdminShell,
  Avatar,
  Badge,
  Button,
  DataTable,
  FeatureCard,
  Grid,
  Icon,
  IconButton,
  Inline,
  LinkText,
  MetricStrip,
  Page,
  PageHeader,
  PageSection,
  PriceDisplay,
  ProductCard,
  PromoStrip,
  SellerBadge,
  Stack,
  Stat,
  Surface,
  Text
} from "@chase-sets/design-system";
import { adminNav, demoProducts } from "../fixtures";

const rows = demoProducts.map((product, index) => ({
  item: product.title,
  condition: index === 1 ? "CGC 9.6" : index === 3 ? "Excellent" : "Mint",
  price: [1250, 1650, 275, 850, 2450][index],
  watchers: [42, 28, 33, 15, 57][index],
  stock: [1, 1, 3, 2, 1][index],
  status: "Active"
}));

export function AdminView() {
  return (
    <AdminShell
      brand={<SellerBadge name="Chase Picks" verified />}
      navItems={adminNav}
      activeKey="overview"
      actions={
        <Inline gap={3}>
          <IconButton label="Notifications" icon="bell" />
          <IconButton label="Messages" icon="message" />
          <Inline gap={2}>
            <Avatar name="Alex R." src="/demo-assets/avatar-alex.svg" />
            <Text size="sm" weight="semibold">Alex R.</Text>
          </Inline>
        </Inline>
      }
    >
      <Page>
        <PageHeader
          title="Seller Dashboard"
          description="Manage listings, track performance, and grow your collectibles business."
          actions={<Button leadingIcon="calendar" tone="secondary">May 12 - Jun 11</Button>}
        />

        <MetricStrip
          items={[
            { label: "Total Sales", value: "$12,846.75", trend: "+18.7% vs prior period" },
            { label: "Active Listings", value: "128", trend: "+6.2% vs prior period" },
            { label: "Orders This Month", value: "42", trend: "+24.1% vs prior period" },
            { label: "Conversion Rate", value: "4.36%", trend: "+0.8pp vs prior period" }
          ]}
        />

        <Grid columns={{ base: 1, lg: 2 }} gap={4}>
          <Surface elevated>
            <Stack gap={4}>
              <Inline gap={3}>
                <Icon name="chart" tone="accent" />
                <Text weight="semibold">Sales Performance</Text>
              </Inline>
              <Stat label="Revenue" value="$12,846.75" trend="+18.7%" />
              <Grid columns={{ base: 4 }} gap={2}>
                <Surface tone="accent" padding={3} />
                <Surface tone="accent" padding={4} />
                <Surface tone="accent" padding={5} />
                <Surface tone="accent" padding={6} />
              </Grid>
            </Stack>
          </Surface>
          <Surface elevated>
            <Stack gap={4}>
              <Inline gap={3}>
                <Icon name="cards" tone="accent" />
                <Text weight="semibold">Category Performance</Text>
              </Inline>
              <FeatureCard icon="cards" title="Trading Cards" description="$5,426.20 in sales" />
              <FeatureCard icon="book" title="Comics" description="$2,341.75 in sales" />
              <FeatureCard icon="sneaker" title="Sneakers" description="$1,987.40 in sales" />
              <LinkText href="#" trailingIcon="chevronRight">View full analytics</LinkText>
            </Stack>
          </Surface>
        </Grid>

        <Grid columns={{ base: 1, xl: 2 }} gap={4}>
          <PageSection title="Recent Orders">
            <DataTable
              density="compact"
              rows={rows}
              columns={[
                { key: "item", header: "Item", cell: (row) => row.item },
                { key: "status", header: "Status", cell: (row) => <Badge tone="info">{row.status}</Badge> },
                { key: "price", header: "Amount", align: "right", cell: (row) => <PriceDisplay amount={row.price} /> }
              ]}
            />
          </PageSection>
          <Stack gap={4}>
            <Surface elevated>
              <Stack gap={3}>
                <Text weight="semibold">Payouts</Text>
                <PriceDisplay amount={2340.5} emphasis />
                <Text size="sm" tone="secondary">Next payout Jun 14, 2024 through PayPal.</Text>
                <Button block>Transfer Now</Button>
              </Stack>
            </Surface>
            <Surface elevated>
              <Stack gap={3}>
                <Inline gap={3}>
                  <Text weight="semibold">Seller Reputation</Text>
                  <Badge tone="info">Verified Seller</Badge>
                </Inline>
                <Inline gap={3}>
                  <Text size="lg" weight="bold">4.9</Text>
                  <Badge tone="warning">5 stars</Badge>
                </Inline>
                <Text size="sm" tone="secondary">Based on 248 reviews with excellent response and shipping speed.</Text>
              </Stack>
            </Surface>
          </Stack>
        </Grid>

        <PageSection title="Active Listings">
          <Grid columns={{ base: 1, md: 3 }} gap={3}>
            {demoProducts.slice(0, 3).map((product) => (
              <ProductCard
                key={product.title}
                title={product.title}
                subtitle={product.subtitle}
                price={product.price}
                imageSrc={product.imageSrc}
                imageAlt={product.title}
                status={<Badge tone="success">Active</Badge>}
                actions={<IconButton label="Listing actions" icon="moreVertical" size="sm" />}
              />
            ))}
          </Grid>
        </PageSection>

        <Grid columns={{ base: 1, lg: 2 }} gap={4}>
          <ActivityList
            items={[
              { title: "New order received", description: "2020 Pikachu VMAX PSA 10", timestamp: "2m ago" },
              { title: "Item shipped", description: "Air Jordan 1 Retro High Chicago", timestamp: "18m ago" },
              { title: "New review", description: "Fast shipping and item as described.", timestamp: "45m ago" }
            ]}
          />
          <PromoStrip
            icon="tag"
            title="List more. Sell more."
            description="Listings with high-quality photos sell up to 2.5x faster."
            action={<Button>Create New Listing</Button>}
          />
        </Grid>
      </Page>
    </AdminShell>
  );
}
