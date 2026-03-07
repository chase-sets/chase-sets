import { useState } from "react";
import {
  Accordion,
  AspectRatio,
  Avatar,
  Badge,
  Banner,
  Box,
  Button,
  ButtonGroup,
  Caption,
  Card,
  Center,
  Cluster,
  type ColorMode,
  ColorModeToggle,
  Container,
  CodeText,
  CopyButton,
  CurrencyInput,
  Dialog,
  Divider,
  Drawer,
  EmptyState,
  EmptyStateIllustration,
  Field,
  Grid,
  Heading,
  HelperText,
  Icon,
  IconButton,
  ImageGallery,
  Inline,
  InlineMessage,
  Inset,
  KeyValueList,
  Label,
  LinkButton,
  LinkText,
  List,
  LoadingSpinner,
  Menu,
  NavRail,
  Page,
  PageHeader,
  PageSection,
  PasswordInput,
  PriceDisplay,
  ProgressBar,
  Quote,
  Rating,
  RecordPage,
  ScrollArea,
  Select,
  Skeleton,
  Spacer,
  Stack,
  StatusPill,
  Surface,
  Table,
  Tag,
  TagInput,
  Text,
  TextInput,
  Thumbnail,
  Timeline,
  VisuallyHidden,
  Wizard
} from "@chase-sets/design-system";
import { adminNav, showcaseIconNames } from "../fixtures";

function RatingDemo() {
  const [value, setValue] = useState(3);

  return (
    <Rating
      value={value}
      max={5}
      size="md"
      interactive
      onValueChange={setValue}
      label="Your rating"
    />
  );
}

function TagInputDemo() {
  const [tags, setTags] = useState(["Pokemon", "Charizard"]);

  return (
    <TagInput
      values={tags}
      onValuesChange={setTags}
      placeholder="Add a tag..."
      maxTags={5}
    />
  );
}

function ColorModeToggleDemo() {
  const [mode, setMode] = useState<ColorMode>("system");

  return <ColorModeToggle value={mode} onValueChange={setMode} />;
}

function WizardDemo() {
  const [step, setStep] = useState("details");

  return (
    <Surface>
      <Wizard
        steps={[
          {
            key: "details",
            label: "Card Details",
            content: (
              <Stack gap={3}>
                <TextInput label="Card name" defaultValue="Charizard ex" />
                <Select
                  label="Set"
                  items={[
                    { value: "ss", label: "Surging Sparks" },
                    { value: "sc", label: "Stellar Crown" }
                  ]}
                />
              </Stack>
            )
          },
          {
            key: "condition",
            label: "Condition & Price",
            content: (
              <Stack gap={3}>
                <Select
                  label="Condition"
                  items={[
                    { value: "nm", label: "Near Mint" },
                    { value: "lp", label: "Light Play" }
                  ]}
                />
                <CurrencyInput label="Price" defaultValue="29.95" />
              </Stack>
            )
          },
          {
            key: "review",
            label: "Review",
            content: (
              <Stack gap={3}>
                <Text>Review your listing before publishing.</Text>
                <KeyValueList
                  items={[
                    { key: "Card", value: "Charizard ex" },
                    { key: "Condition", value: "Near Mint" },
                    { key: "Price", value: "$29.95" }
                  ]}
                />
              </Stack>
            )
          }
        ]}
        activeStep={step}
        onStepChange={setStep}
        onComplete={() => {}}
      />
    </Surface>
  );
}

function ShowcaseIconCard({
  name
}: {
  name: (typeof showcaseIconNames)[number];
}) {
  return (
    <Surface>
      <Stack gap={1} align="center">
        <Icon name={name} size="md" tone="accent" />
        <Caption>{name}</Caption>
      </Stack>
    </Surface>
  );
}

export function ComponentsView() {
  return (
    <Page>
      <PageHeader
        eyebrow="Primitives"
        title="Layout, typography, and feedback components"
        description="Atomic building blocks that compose into marketplace and admin surfaces."
      />

      <PageSection title="Icons">
        <Surface>
          <Inline gap={4}>
            {showcaseIconNames.map((name) => (
              <ShowcaseIconCard key={name} name={name} />
            ))}
          </Inline>
        </Surface>
      </PageSection>

      <PageSection title="Typography">
        <Surface>
          <Stack gap={4}>
            <Heading level={1}>Heading 1 - Display</Heading>
            <Heading level={2}>Heading 2</Heading>
            <Heading level={3}>Heading 3</Heading>
            <Heading level={4}>Heading 4</Heading>
            <Heading level={5}>Heading 5</Heading>
            <Heading level={6}>Heading 6</Heading>
            <Divider />
            <Text>Body text in the default size and weight.</Text>
            <Text size="lg" weight="semibold">
              Large semibold text for emphasis.
            </Text>
            <Text size="sm" tone="secondary">
              Small secondary text for supporting content.
            </Text>
            <Caption>Caption text for metadata and timestamps.</Caption>
            <Label>Form label</Label>
            <Label muted>Muted label</Label>
            <Text>
              Inline <CodeText>code snippets</CodeText> render in the mono font.
            </Text>
            <LinkText href="#">Accent link with default styling</LinkText>
            <LinkText href="#" tone="subtle" trailingIcon="chevronRight">
              Subtle link with trailing icon
            </LinkText>
            <Quote cite="- Design system principles">
              Every component should be composable, accessible, and theme-aware
              without requiring custom CSS.
            </Quote>
            <List
              items={[
                "Near Mint (NM)",
                "Light Play (LP)",
                "Moderate Play (MP)",
                "Heavy Play (HP)"
              ]}
            />
            <List
              ordered
              items={[
                "Search for your card",
                "Compare seller prices",
                "Add to cart and checkout"
              ]}
            />
          </Stack>
        </Surface>
      </PageSection>

      <PageSection title="Layout Primitives">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Box & Inset</Heading>
              <Box padding={4} gap={2}>
                <Text size="sm" tone="secondary">
                  Box with padding=4 and gap=2
                </Text>
                <Inset padding={3}>
                  <Surface tone="muted">
                    <Text size="sm">Inset content inside a Box</Text>
                  </Surface>
                </Inset>
              </Box>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Center</Heading>
              <Surface tone="muted">
                <Center>
                  <Stack gap={2} align="center">
                    <Icon name="spark" size="lg" tone="accent" />
                    <Text size="sm">Centered content</Text>
                  </Stack>
                </Center>
              </Surface>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Cluster</Heading>
              <Cluster gap={2}>
                <Badge>Tag A</Badge>
                <Badge tone="accent">Tag B</Badge>
                <Badge tone="success">Tag C</Badge>
                <Badge tone="warning">Tag D</Badge>
                <Badge tone="info">Tag E</Badge>
              </Cluster>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Spacer</Heading>
              <Surface tone="muted">
                <Text size="sm">Above spacer</Text>
                <Spacer size={4} />
                <Text size="sm">Below spacer (size=4)</Text>
              </Surface>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Container</Heading>
              <Container width="narrow" paddingX={4}>
                <Surface tone="muted">
                  <Text size="sm">Narrow container (max-w-3xl)</Text>
                </Surface>
              </Container>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>AspectRatio</Heading>
              <AspectRatio ratio={16 / 9}>
                <Surface tone="accent" padding={0}>
                  <Center>
                    <Text tone="inverse" weight="semibold">
                      16:9
                    </Text>
                  </Center>
                </Surface>
              </AspectRatio>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>ScrollArea</Heading>
              <ScrollArea height="sm">
                <Stack gap={2}>
                  {Array.from({ length: 12 }, (_, index) => (
                    <Inset key={index} padding={3}>
                      <Text size="sm">Scrollable item {index + 1}</Text>
                    </Inset>
                  ))}
                </Stack>
              </ScrollArea>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Divider</Heading>
              <Text size="sm">Content above</Text>
              <Divider />
              <Text size="sm">Content below</Text>
              <Inline gap={3} align="center">
                <Text size="sm">Left</Text>
                <Divider orientation="vertical" />
                <Text size="sm">Right</Text>
              </Inline>
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Buttons & Navigation">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Button Variants</Heading>
              <Inline gap={2}>
                <Button>Primary</Button>
                <Button tone="secondary">Secondary</Button>
                <Button tone="ghost">Ghost</Button>
                <Button tone="danger">Danger</Button>
              </Inline>
              <Inline gap={2}>
                <Button size="sm">Small</Button>
                <Button size="md">Medium</Button>
                <Button size="lg">Large</Button>
              </Inline>
              <Inline gap={2}>
                <IconButton label="Search" icon="search" />
                <IconButton label="Settings" icon="settings" tone="secondary" />
                <IconButton label="Close" icon="close" tone="ghost" />
              </Inline>
              <LinkButton href="#" leadingIcon="cart">
                Link as button
              </LinkButton>
              <ButtonGroup>
                <Button tone="secondary" size="sm">
                  Secondary action
                </Button>
                <Button size="sm">Primary action</Button>
              </ButtonGroup>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>NavRail</Heading>
              <NavRail items={adminNav} activeKey="dashboard" />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Feedback & Overlays">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Badges & Pills</Heading>
              <Inline gap={2}>
                <Badge>Neutral</Badge>
                <Badge tone="accent">Accent</Badge>
                <Badge tone="success">Success</Badge>
                <Badge tone="warning">Warning</Badge>
                <Badge tone="danger">Danger</Badge>
                <Badge tone="info">Info</Badge>
              </Inline>
              <Inline gap={2}>
                <StatusPill tone="success">Active</StatusPill>
                <StatusPill tone="warning">Pending</StatusPill>
                <StatusPill tone="danger">Sold out</StatusPill>
              </Inline>
              <Inline gap={2}>
                <Tag onRemove={() => {}}>Removable</Tag>
                <Tag tone="accent" onRemove={() => {}}>
                  Accent tag
                </Tag>
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Banners</Heading>
              <Banner
                tone="success"
                title="Import complete"
                description="42 new listings are live."
              />
              <Banner
                tone="warning"
                title="Low stock alert"
                description="19 SKUs need restocking."
              />
              <Banner
                tone="danger"
                title="Payment failed"
                description="Update your billing method."
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Loading States</Heading>
              <LoadingSpinner size="sm" label="Fetching listings..." />
              <LoadingSpinner size="md" label="Processing order..." />
              <ProgressBar value={65} tone="accent" />
              <ProgressBar value={30} tone="warning" />
              <Skeleton height="sm" />
              <Skeleton height="md" />
              <Skeleton height="lg" />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Dialogs & Drawers</Heading>
              <Inline gap={2}>
                <Dialog
                  trigger={<Button tone="secondary">Open dialog</Button>}
                  title="Confirm action"
                  description="This demonstrates the Dialog component."
                  footer={<Button>Done</Button>}
                >
                  <Text>Dialog content with any components inside.</Text>
                </Dialog>
                <Drawer
                  trigger={<Button tone="secondary">Open drawer</Button>}
                  title="Listing details"
                  description="Side panel for editing."
                >
                  <Stack gap={3}>
                    <TextInput label="Title" defaultValue="Charizard ex" />
                    <CurrencyInput label="Price" defaultValue="29.95" />
                  </Stack>
                </Drawer>
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Inline Messages & Helpers</Heading>
              <InlineMessage tone="default" icon="info">
                Informational message for the user.
              </InlineMessage>
              <InlineMessage tone="success" icon="check">
                Operation completed successfully.
              </InlineMessage>
              <InlineMessage tone="danger" icon="warning">
                Something needs attention.
              </InlineMessage>
              <Field label="Example field">
                <Text size="sm" tone="secondary">
                  Field wrapper for custom content.
                </Text>
              </Field>
              <HelperText>Default helper text below a field.</HelperText>
              <HelperText tone="danger">Error helper text.</HelperText>
              <HelperText tone="success">Success helper text.</HelperText>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Empty States</Heading>
              <EmptyState
                title="No results found"
                description="Try adjusting your search or filters."
                icon="search"
                actions={
                  <Button tone="secondary" size="sm">
                    Clear filters
                  </Button>
                }
              />
              <EmptyStateIllustration title="No chart data yet" />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Data Display">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Table (simple)</Heading>
              <Table
                columns={["Set", "Cards", "Completion"]}
                rows={[
                  ["Surging Sparks", "195", "82%"],
                  ["Stellar Crown", "175", "64%"],
                  ["Twilight Masquerade", "198", "91%"]
                ]}
                caption="Set completion tracker"
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Avatars</Heading>
              <Inline gap={3}>
                <Avatar name="Todd S." size="sm" />
                <Avatar name="North Side" size="md" />
                <Avatar name="Gem Mint TCG" size="lg" />
              </Inline>
              <Heading level={5}>Thumbnails</Heading>
              <Grid columns={{ base: 3 }} gap={2}>
                <Thumbnail alt="Card front" ratio={3 / 4} icon="spark" />
                <Thumbnail alt="Card back" ratio={3 / 4} icon="package" />
                <Thumbnail alt="Card detail" ratio={3 / 4} icon="search" />
              </Grid>
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="RecordPage Pattern">
        <RecordPage
          header={
            <PageHeader
              eyebrow="Order #1042"
              title="Charizard ex - 199/165"
              actions={
                <Inline gap={2}>
                  <Button tone="secondary">Edit</Button>
                  <Button tone="danger">Cancel order</Button>
                </Inline>
              }
            />
          }
          summary={
            <Stack gap={4}>
              <KeyValueList
                items={[
                  { key: "Buyer", value: "Todd S." },
                  { key: "Status", value: "Shipped" },
                  { key: "Tracking", value: "9400111899223" },
                  { key: "Total", value: "$34.20" }
                ]}
              />
              <Timeline
                items={[
                  { title: "Delivered", timestamp: "Mar 5, 2026" },
                  { title: "In transit", timestamp: "Mar 3, 2026" },
                  { title: "Shipped", timestamp: "Mar 2, 2026" },
                  { title: "Order placed", timestamp: "Mar 1, 2026" }
                ]}
              />
            </Stack>
          }
          details={
            <Surface>
              <Stack gap={4}>
                <Heading level={5}>Order Details</Heading>
                <KeyValueList
                  items={[
                    { key: "Card", value: "Charizard ex" },
                    { key: "Set", value: "Surging Sparks" },
                    { key: "Condition", value: "Near Mint" },
                    { key: "Seller", value: "North Side Cards" }
                  ]}
                />
              </Stack>
            </Surface>
          }
        />
      </PageSection>

      <PageSection title="New Components">
        <Grid columns={{ base: 1, md: 2 }} gap={4}>
          <Card>
            <Stack gap={3}>
              <Heading level={5}>Rating</Heading>
              <Inline gap={4} align="center">
                <Rating value={4} max={5} size="md" label="Product rating" />
                <Rating value={3.5} max={5} size="sm" label="Small rating" />
              </Inline>
              <Text size="sm" tone="secondary">
                Interactive rating:
              </Text>
              <RatingDemo />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>CopyButton</Heading>
              <Inline gap={2}>
                <CopyButton
                  value="CS-001-NM"
                  label="Copy SKU"
                  copiedLabel="SKU copied!"
                />
                <CopyButton
                  value="https://chase-sets.com/listing/199"
                  tone="ghost"
                />
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Accordion</Heading>
              <Accordion
                type="single"
                collapsible
                items={[
                  {
                    value: "details",
                    trigger: "Card Details",
                    content: (
                      <Text size="sm">
                        Charizard ex - 199/165, Surging Sparks. Illustration
                        rare with textured holo.
                      </Text>
                    )
                  },
                  {
                    value: "condition",
                    trigger: "Condition Guide",
                    content: (
                      <Text size="sm">
                        Near Mint (NM): Minimal edge wear, no scratches on holo
                        surface.
                      </Text>
                    )
                  },
                  {
                    value: "shipping",
                    trigger: "Shipping Policy",
                    content: (
                      <Text size="sm">
                        Free standard shipping on orders over $25. Cards ship in
                        penny sleeve + toploader.
                      </Text>
                    )
                  }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>ImageGallery</Heading>
              <ImageGallery
                images={[
                  {
                    src: "https://placehold.co/300x400/1a1a2e/eaeaea?text=Front",
                    alt: "Card front"
                  },
                  {
                    src: "https://placehold.co/300x400/16213e/eaeaea?text=Back",
                    alt: "Card back"
                  },
                  {
                    src: "https://placehold.co/300x400/0f3460/eaeaea?text=Close-up",
                    alt: "Holo close-up"
                  }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>TagInput</Heading>
              <TagInputDemo />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>PasswordInput</Heading>
              <PasswordInput label="Password" placeholder="Enter password" />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Card with Media Slot</Heading>
              <Card
                media={
                  <AspectRatio ratio={3 / 4}>
                    <Surface tone="accent" padding={0}>
                      <Center>
                        <Icon name="image" size="lg" tone="inverse" />
                      </Center>
                    </Surface>
                  </AspectRatio>
                }
                interactive
              >
                <Stack gap={1}>
                  <Text weight="semibold">Charizard ex - 199/165</Text>
                  <Text size="sm" tone="secondary">
                    Near Mint - Surging Sparks
                  </Text>
                  <PriceDisplay amount={29.95} />
                </Stack>
              </Card>
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Enhanced Menu</Heading>
              <Menu
                trigger={<Button tone="secondary">Actions menu</Button>}
                groups={[
                  {
                    label: "Listing",
                    items: [
                      {
                        key: "edit",
                        label: "Edit listing",
                        icon: "edit",
                        onSelect: () => {}
                      },
                      {
                        key: "copy",
                        label: "Copy link",
                        icon: "copy",
                        shortcut: "Ctrl+C",
                        onSelect: () => {}
                      }
                    ]
                  },
                  {
                    label: "Danger zone",
                    items: [
                      {
                        key: "delete",
                        label: "Delete listing",
                        icon: "trash",
                        disabled: false,
                        onSelect: () => {}
                      }
                    ]
                  }
                ]}
              />
            </Stack>
          </Card>

          <Card>
            <Stack gap={3}>
              <Heading level={5}>Design System ColorModeToggle</Heading>
              <ColorModeToggleDemo />
            </Stack>
          </Card>
        </Grid>
      </PageSection>

      <PageSection title="Wizard Pattern">
        <WizardDemo />
      </PageSection>

      <VisuallyHidden>
        <Text>
          This text is visually hidden but available to screen readers.
        </Text>
      </VisuallyHidden>
    </Page>
  );
}
