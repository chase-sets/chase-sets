import {
  Badge,
  Button,
  CategoryTile,
  Divider,
  FeatureCard,
  Grid,
  Heading,
  Icon,
  IconButton,
  Inline,
  LinkButton,
  MarketplaceShell,
  PageSection,
  ProductCard,
  PromoStrip,
  Rating,
  SearchInput,
  SellerBadge,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text
} from "@chase-sets/design-system";
import { demoProducts, marketplaceNav } from "../fixtures";

export function MarketplaceView() {
  const heroProduct = demoProducts[0];

  return (
    <MarketplaceShell
      brand={<SellerBadge name="Chase Sets" verified />}
      topNavItems={marketplaceNav}
      bottomNavItems={marketplaceNav}
      activeKey="browse"
      actions={
        <Inline gap={2}>
          <LinkButton href="#signin" tone="ghost">
            Sign In
          </LinkButton>
          <Button>Get Started</Button>
        </Inline>
      }
      hero={
        <Surface elevated glow padding={6}>
          <Grid columns={{ base: 1, lg: 2 }} gap={6}>
            <Stack gap={5} justify="center">
              <Stack gap={3}>
                <Inline gap={2}>
                  <Badge tone="accent">Verified marketplace</Badge>
                  <Badge tone="info">Collector owned</Badge>
                </Inline>
                <Heading level={1}>
                  Buy, sell, and discover the collectibles worth chasing.
                </Heading>
                <Text tone="secondary">
                  The trusted marketplace for trading cards, comics, figures,
                  sneakers, and more. Authentic. Secure. Built for collectors.
                </Text>
              </Stack>
              <Inline gap={3}>
                <Button size="lg">Explore Marketplace</Button>
                <Button size="lg" tone="secondary">
                  Start Selling
                </Button>
              </Inline>
              <StatGrid columns={{ base: 1, sm: 3 }}>
                <Stat label="Active Listings" value="100K+" />
                <Stat label="Collectors" value="75K+" />
                <Stat label="Avg Rating" value="4.9" trend={<Rating value={5} size="sm" />} />
              </StatGrid>
            </Stack>
            <Stack gap={4}>
              <ProductCard
                title={heroProduct.title}
                subtitle={heroProduct.subtitle}
                price={heroProduct.price}
                imageSrc={heroProduct.imageSrc}
                imageAlt={heroProduct.title}
                imageFit="contain"
                status={<Badge tone="info">Featured</Badge>}
                meta="Champion's Path #074"
              />
              <Surface tone="subtle" padding={4}>
                <Stack gap={3}>
                  <Inline gap={2}>
                    <Icon name="shield" tone="accent" />
                    <Text weight="semibold">Buyer protection on every order</Text>
                  </Inline>
                  <Divider />
                  <Grid columns={{ base: 1, sm: 3 }} gap={3}>
                    <Stat label="Verified Sellers" value="2K+" />
                    <Stat label="Protected Orders" value="98%" />
                    <Stat label="Avg Ship" value="1.2d" />
                  </Grid>
                </Stack>
              </Surface>
            </Stack>
          </Grid>
        </Surface>
      }
    >
      <Surface elevated padding={4}>
        <Stack gap={3}>
          <SearchInput
            label="Marketplace search"
            hideLabel
            placeholder="Search for cards, comics, figures, sneakers, and more..."
          />
          <Grid columns={{ base: 2, md: 5 }} gap={3}>
            <CategoryTile icon="cards" label="Trading Cards" />
            <CategoryTile icon="book" label="Comics" />
            <CategoryTile icon="figure" label="Figures" />
            <CategoryTile icon="sneaker" label="Sneakers" />
            <CategoryTile icon="shirt" label="Memorabilia" />
          </Grid>
        </Stack>
      </Surface>

      <PageSection
        title="Featured Collectibles"
        description="High-signal marketplace cards for comparing product, price, status, and action states."
      >
        <Grid columns={{ base: 1, sm: 2, lg: 5 }} gap={3}>
          {demoProducts.map((product) => (
            <ProductCard
              key={product.title}
              title={product.title}
              subtitle={product.subtitle}
              price={product.price}
              imageSrc={product.imageSrc}
              imageAlt={product.title}
              status={<Badge tone={product.status === "Hot" ? "warning" : "info"}>{product.status}</Badge>}
              actions={<IconButton label="Save item" icon="heart" size="sm" />}
            />
          ))}
        </Grid>
      </PageSection>

      <PageSection title="Trending Categories">
        <Grid columns={{ base: 2, md: 5 }} gap={3}>
          <CategoryTile icon="cards" label="Trading Cards" detail="120K+ items" />
          <CategoryTile icon="book" label="Comics" detail="38K+ items" />
          <CategoryTile icon="figure" label="Figures" detail="22K+ items" />
          <CategoryTile icon="sneaker" label="Sneakers" detail="14K+ items" />
          <CategoryTile icon="shirt" label="Memorabilia" detail="9K+ items" />
          <CategoryTile icon="grid" label="All Categories" detail="Browse all" />
        </Grid>
      </PageSection>

      <PageSection title="How Chase Sets Works">
        <Grid columns={{ base: 1, md: 3 }} gap={4}>
          <FeatureCard icon="search" title="Discover" description="Explore verified collectibles from trusted sellers around the world." />
          <FeatureCard icon="shield" title="Buy Securely" description="Checkout and buyer protection are designed into every order." />
          <FeatureCard icon="tag" title="Sell Easily" description="List items quickly and reach collectors who are ready to buy." />
        </Grid>
      </PageSection>

      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label="Active Listings" value="100K+" />
        <Stat label="Happy Collectors" value="75K+" />
        <Stat label="Verified Sellers" value="2K+" />
        <Stat label="Average Rating" value="4.9/5" trend={<Rating value={5} size="sm" />} />
      </StatGrid>

      <Grid columns={{ base: 1, md: 4 }} gap={4}>
        <FeatureCard icon="shield" title="Authenticity First" description="Collectibles are verified by trusted marketplace partners." />
        <FeatureCard icon="lock" title="Buyer Protection" description="Secure payments and hassle-free returns on eligible orders." />
        <FeatureCard icon="chart" title="Transparent Pricing" description="Real market data helps buyers and sellers move with confidence." />
        <FeatureCard icon="users" title="Community Driven" description="Collectors, sellers, and enthusiasts all in one marketplace." />
      </Grid>

      <PromoStrip
        icon="spark"
        title="Ready to find your next grail?"
        description="Join collectors buying, selling, and building legendary collections."
        action={<Button>Get Started</Button>}
      />
      <Inline gap={2}>
        <Icon name="shield" tone="accent" />
        <Text size="sm" tone="secondary">
          Authenticity first, transparent pricing, and community-driven trust.
        </Text>
      </Inline>
    </MarketplaceShell>
  );
}
