import {
  Button,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { DiscoveryCategoryItem } from "../../categories/ui/contracts";

interface SearchFiltersProps {
  categories: DiscoveryCategoryItem[];
  selectedCategory: string;
  onCategoryChange: (name: string) => void;
}

export function SearchFilters({
  categories,
  selectedCategory,
  onCategoryChange,
}: SearchFiltersProps) {
  return (
    <Stack gap={4}>
      <Text weight="semibold" size="sm">Categories</Text>
      <Stack gap={1}>
        <Button
          tone={!selectedCategory ? "primary" : "ghost"}
          size="sm"
          onClick={() => onCategoryChange("")}
          block
        >
          All Categories
        </Button>
        {categories.map((category) => (
          <Button
            key={category.category_id}
            tone={selectedCategory === category.name ? "primary" : "ghost"}
            size="sm"
            onClick={() => onCategoryChange(category.name)}
            block
          >
            {category.name} ({category.item_count})
          </Button>
        ))}
      </Stack>
    </Stack>
  );
}


