import type { ReactNode } from "react";
import { Box, Container, Inline, Stack } from "../../primitives/layout";
import { Text } from "../../primitives/typography";
import { cx } from "../../utils/cx";
import { Badge } from "../feedback/badge";

export interface NavigationHeaderItem {
  label: ReactNode;
  href: string;
  active?: boolean;
}

export interface NavigationHeaderProps {
  brand: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  logo?: ReactNode;
  items: NavigationHeaderItem[];
  actions?: ReactNode;
  ariaLabel?: string;
  sticky?: boolean;
  className?: string;
}

export function NavigationHeader({
  brand,
  badge,
  description,
  logo,
  items,
  actions,
  ariaLabel = "Primary navigation",
  sticky = true,
  className,
}: NavigationHeaderProps) {
  return (
    <header
      className={cx(
        "z-40 border-b border-muted bg-background/overlay backdrop-blur",
        sticky && "sticky top-0",
        className,
      )}
    >
      <Container width="wide">
        <Box paddingY={4}>
          <Stack
            direction={{ base: "column", md: "row" }}
            align={{ base: "stretch", md: "center" }}
            justify={{ base: "start", md: "between" }}
            gap={4}
          >
            <Stack direction="row" align="center" gap={3} minWidth="0">
              {logo ? (
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-tokenLg border border-border bg-surface shadow-tokenSm">
                  {logo}
                </div>
              ) : null}
              <Box minWidth="0">
                <Inline gap={2}>
                  <strong className="ds-display truncate text-2xl">{brand}</strong>
                  {badge ? (
                    <Badge variant="solid" tone="neutral">
                      {badge}
                    </Badge>
                  ) : null}
                </Inline>
                {description ? (
                  <Text element="p" size="sm" tone="secondary">
                    {description}
                  </Text>
                ) : null}
              </Box>
            </Stack>
            <Inline gap={3}>
              <nav aria-label={ariaLabel}>
                <Inline gap={2}>
                  {items.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      aria-current={item.active ? "page" : undefined}
                      className={cx(
                        "rounded-tokenMd px-3 py-2 text-sm font-semibold transition-colors",
                        item.active
                          ? "bg-accent text-accent-contrast shadow-tokenSm"
                          : "text-secondary hover:bg-surface-2 hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </a>
                  ))}
                </Inline>
              </nav>
              {actions ? <Inline gap={2}>{actions}</Inline> : null}
            </Inline>
          </Stack>
        </Box>
      </Container>
    </header>
  );
}
