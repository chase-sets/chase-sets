export function buildOpenGraphMeta({
  title,
  description = title,
  siteName = "Chase Sets",
  imageUrl,
  type = "website",
}: Readonly<{
  title: string;
  description?: string;
  siteName?: string;
  imageUrl?: string;
  type?: "website" | "product";
}>) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      name: "twitter:card",
      content: imageUrl ? "summary_large_image" : "summary",
    },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
