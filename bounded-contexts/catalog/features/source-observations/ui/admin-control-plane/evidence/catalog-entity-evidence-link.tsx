import { LinkText } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { catalogEntityEvidenceHref, type CatalogEvidenceReference } from "../../primary-workbench-evidence-reference";

export function CatalogEntityEvidenceLink({
  location,
  reference,
}: Readonly<{
  location: string;
  reference: CatalogEvidenceReference;
}>) {
  return (
    <LinkText href={catalogEntityEvidenceHref(location, reference)}>
      {t("catalog.features.sourceObservations.ui.auditEvidence.title")}: {reference.id}
    </LinkText>
  );
}
