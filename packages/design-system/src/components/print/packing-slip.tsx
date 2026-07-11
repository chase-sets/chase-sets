// @ds-leaf Print-isolated packing slip: owns hand-authored BEM class names and
// hardcoded hex print styles (no Tailwind/tokens resolve at print time), so it is
// exempt from the design-system HOC raw-className budget by design.
import type { ReactNode } from "react";
import { Button } from "../actions/button";
import { Form } from "../forms/form";
import { HiddenInput } from "../forms/hidden-input";
import { NativeSelect } from "../forms/select";
import { cx } from "../../utils/cx";

export type PackingSlipPrintFormat = "letter" | "thermal-4x6";

export interface PackingSlipPrintLine {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
  summary?: ReactNode;
  quantity: ReactNode;
}

export interface PackingSlipPrintSlip {
  id: string;
  orderReference: ReactNode;
  referenceLabel: ReactNode;
  referenceValue: ReactNode;
  shipToTitle: ReactNode;
  shipToLines: readonly ReactNode[];
  shipFromTitle?: ReactNode;
  shipFromLines?: readonly ReactNode[];
  itemsTitle: ReactNode;
  lines: readonly PackingSlipPrintLine[];
  footer: ReactNode;
}

export interface PackingSlipPrintToolbarProps {
  eyebrow: ReactNode;
  title: ReactNode;
  description: ReactNode;
  formatLabel: string;
  format: PackingSlipPrintFormat;
  letterLabel: string;
  thermalLabel: string;
  changeFormatLabel: ReactNode;
  printLabel: ReactNode;
  shipmentIds: readonly string[];
  shipmentIdFieldName?: string;
  formatFieldName?: string;
}

export interface PackingSlipPrintDocumentProps {
  format: PackingSlipPrintFormat;
  toolbar: PackingSlipPrintToolbarProps;
  slips: readonly PackingSlipPrintSlip[];
  labels: {
    packingSlip: ReactNode;
    order: ReactNode;
    item: ReactNode;
    product: ReactNode;
    quantity: ReactNode;
    standardProduct: ReactNode;
  };
}

function printSizeClass(format: PackingSlipPrintFormat) {
  return format === "thermal-4x6" ? "fulfillment-packing-slip--thermal" : "fulfillment-packing-slip--letter";
}

function printPageSize(format: PackingSlipPrintFormat) {
  return format === "thermal-4x6" ? "4in 6in" : "letter";
}

export function packingSlipPrintStyles(format: PackingSlipPrintFormat) {
  return `
        .fulfillment-packing-slip-page {
          --packing-slip-shell-background: #f8fafc;
          --packing-slip-shell-text: #0f172a;
          --packing-slip-shell-secondary-text: #334155;
          --packing-slip-shell-muted-text: #475569;
          --packing-slip-shell-trust-text: #0f766e;
          --packing-slip-shell-control-background: #ffffff;
          --packing-slip-shell-control-border: #94a3b8;
          --packing-slip-shell-primary-background: #0f172a;
          --packing-slip-shell-primary-border: #0f172a;
          --packing-slip-shell-primary-text: #ffffff;
          --packing-slip-shell-secondary-background: #ffffff;
          --packing-slip-shell-secondary-border: #0f172a;
          --packing-slip-shell-secondary-action-text: #0f172a;
          --packing-slip-shell-focus-ring: #0f766e;

          background: var(--packing-slip-shell-background);
          color: var(--packing-slip-shell-text);
          color-scheme: light;
          margin: 0;
          min-height: 100vh;
          padding: 1.5rem;
        }

        [data-theme="dark"] .fulfillment-packing-slip-page {
          --packing-slip-shell-background: #020617;
          --packing-slip-shell-text: #f8fafc;
          --packing-slip-shell-secondary-text: #cbd5e1;
          --packing-slip-shell-muted-text: #94a3b8;
          --packing-slip-shell-trust-text: #2dd4bf;
          --packing-slip-shell-control-background: #111827;
          --packing-slip-shell-control-border: #475569;
          --packing-slip-shell-primary-background: #f8fafc;
          --packing-slip-shell-primary-border: #f8fafc;
          --packing-slip-shell-primary-text: #020617;
          --packing-slip-shell-secondary-background: transparent;
          --packing-slip-shell-secondary-border: #64748b;
          --packing-slip-shell-secondary-action-text: #f8fafc;
          --packing-slip-shell-focus-ring: #93c5fd;

          color-scheme: dark;
        }

        @media (prefers-color-scheme: dark) {
          :root:not([data-theme="light"]) .fulfillment-packing-slip-page {
            --packing-slip-shell-background: #020617;
            --packing-slip-shell-text: #f8fafc;
            --packing-slip-shell-secondary-text: #cbd5e1;
            --packing-slip-shell-muted-text: #94a3b8;
            --packing-slip-shell-trust-text: #2dd4bf;
            --packing-slip-shell-control-background: #111827;
            --packing-slip-shell-control-border: #475569;
            --packing-slip-shell-primary-background: #f8fafc;
            --packing-slip-shell-primary-border: #f8fafc;
            --packing-slip-shell-primary-text: #020617;
            --packing-slip-shell-secondary-background: transparent;
            --packing-slip-shell-secondary-border: #64748b;
            --packing-slip-shell-secondary-action-text: #f8fafc;
            --packing-slip-shell-focus-ring: #93c5fd;

            color-scheme: dark;
          }
        }

        .fulfillment-packing-slip-toolbar {
          align-items: end;
          display: flex;
          flex-wrap: wrap;
          gap: 1rem;
          justify-content: space-between;
          margin-inline: auto;
          margin-bottom: 1rem;
          max-width: 72rem;
        }

        .fulfillment-packing-slip-toolbar__copy {
          min-width: 16rem;
        }

        .fulfillment-packing-slip-toolbar__eyebrow {
          color: var(--packing-slip-shell-trust-text);
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          margin: 0 0 0.25rem;
          text-transform: uppercase;
        }

        .fulfillment-packing-slip-toolbar__title {
          color: var(--packing-slip-shell-text);
          font-size: 2rem;
          font-weight: 700;
          line-height: 1.1;
          margin: 0;
        }

        .fulfillment-packing-slip-toolbar__description {
          color: var(--packing-slip-shell-muted-text);
          margin: 0.5rem 0 0;
        }

        .fulfillment-packing-slip-toolbar__actions,
        .fulfillment-packing-slip-toolbar__form {
          align-items: end;
          display: flex;
          flex-wrap: wrap;
          gap: 0.75rem;
        }

        .fulfillment-packing-slip-print-root {
          display: grid;
          gap: 1rem;
          margin-inline: auto;
          max-width: 8.5in;
        }

        .fulfillment-packing-slip {
          aspect-ratio: 8.5 / 11;
          background: white;
          border: 1px solid #cbd5e1;
          box-shadow: 0 1.5rem 3rem rgb(15 23 42 / 0.12);
          color: #0f172a;
          display: grid;
          gap: 1rem;
          justify-self: center;
          max-width: 8.5in;
          min-width: 0;
          page-break-after: always;
          width: 100%;
        }

        .fulfillment-packing-slip--letter {
          padding: 0.5in;
        }

        .fulfillment-packing-slip--thermal {
          aspect-ratio: 4 / 6;
          max-width: 4in;
          padding: 0.18in;
        }

        .fulfillment-packing-slip__header {
          align-items: start;
          border-bottom: 1px solid #cbd5e1;
          display: grid;
          gap: 0.5rem;
          grid-template-columns: 1fr auto;
          padding-bottom: 0.75rem;
        }

        .fulfillment-packing-slip__title {
          font-size: 1.25rem;
          font-weight: 700;
          margin: 0;
        }

        .fulfillment-packing-slip__reference {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 0.75rem;
          overflow-wrap: anywhere;
          text-align: right;
        }

        .fulfillment-packing-slip__grid {
          display: grid;
          gap: 1rem;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .fulfillment-packing-slip__section-title {
          font-size: 0.75rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          margin: 0 0 0.35rem;
          text-transform: uppercase;
        }

        .fulfillment-packing-slip__address-line,
        .fulfillment-packing-slip__meta-line {
          font-size: 0.82rem;
          line-height: 1.25rem;
          overflow-wrap: anywhere;
        }

        .fulfillment-packing-slip__table {
          border-collapse: collapse;
          font-size: 0.82rem;
          width: 100%;
        }

        .fulfillment-packing-slip__table th,
        .fulfillment-packing-slip__table td {
          border-bottom: 1px solid #e2e8f0;
          overflow-wrap: anywhere;
          padding: 0.35rem 0.25rem;
          text-align: left;
          vertical-align: top;
        }

        .fulfillment-packing-slip__qty {
          text-align: right;
          white-space: nowrap;
          width: 3rem;
        }

        .fulfillment-packing-slip__footer {
          color: #475569;
          font-size: 0.875rem;
          overflow-wrap: anywhere;
        }

        .fulfillment-packing-slip--thermal {
          gap: 0.5rem;
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__header {
          grid-template-columns: 1fr;
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__reference {
          text-align: left;
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__grid {
          gap: 0.35rem;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__title {
          font-size: 1rem;
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__section-title {
          margin-bottom: 0.2rem;
        }

        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__address-line,
        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__meta-line,
        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__table,
        .fulfillment-packing-slip--thermal .fulfillment-packing-slip__footer {
          font-size: 0.72rem;
          line-height: 1rem;
        }

        @media screen and (max-width: 700px) {
          .fulfillment-packing-slip-page {
            padding: 1rem;
          }

          .fulfillment-packing-slip-toolbar {
            align-items: stretch;
          }

          .fulfillment-packing-slip-toolbar__copy {
            min-width: 0;
          }

          .fulfillment-packing-slip-toolbar__title {
            font-size: 1.6rem;
          }

          .fulfillment-packing-slip-toolbar__actions,
          .fulfillment-packing-slip-toolbar__form {
            width: 100%;
          }

          .fulfillment-packing-slip-toolbar__form > * {
            width: 100%;
          }

          .fulfillment-packing-slip {
            aspect-ratio: auto;
            gap: 1.25rem;
            padding: 1rem;
          }

          .fulfillment-packing-slip__header,
          .fulfillment-packing-slip__grid {
            grid-template-columns: 1fr;
          }

          .fulfillment-packing-slip--thermal .fulfillment-packing-slip__grid {
            gap: 0.35rem;
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .fulfillment-packing-slip__reference {
            text-align: left;
          }

          .fulfillment-packing-slip__table,
          .fulfillment-packing-slip__table tbody,
          .fulfillment-packing-slip__table tr,
          .fulfillment-packing-slip__table td {
            display: block;
          }

          .fulfillment-packing-slip__table thead {
            display: none;
          }

          .fulfillment-packing-slip__table tr {
            border-bottom: 1px solid #e2e8f0;
            padding: 0.5rem 0;
          }

          .fulfillment-packing-slip__table td {
            border-bottom: 0;
            padding: 0.15rem 0;
          }

          .fulfillment-packing-slip__qty {
            text-align: left;
            width: auto;
          }

          .fulfillment-packing-slip__qty::before {
            content: "Qty: ";
            font-weight: 700;
          }
        }

        @media print {
          @page {
            margin: 0;
            size: ${printPageSize(format)};
          }

          body {
            background: white !important;
          }

          body * {
            visibility: hidden;
          }

          .fulfillment-packing-slip-print-root,
          .fulfillment-packing-slip-print-root * {
            visibility: visible;
          }

          .fulfillment-packing-slip-toolbar {
            display: none !important;
          }

          .fulfillment-packing-slip-print-root {
            display: block;
            inset: 0;
            max-width: none;
            position: absolute;
          }

          .fulfillment-packing-slip {
            aspect-ratio: auto;
            border: 0;
            box-shadow: none;
            break-after: page;
            margin: 0;
            max-width: none;
          }

          .fulfillment-packing-slip--letter {
            height: 11in;
            width: 8.5in;
          }

          .fulfillment-packing-slip--thermal {
            height: 6in;
            width: 4in;
          }

          .fulfillment-packing-slip-print-root[data-format="thermal-4x6"] {
            width: 4in;
          }

          .fulfillment-packing-slip-print-root[data-format="thermal-4x6"] .fulfillment-packing-slip {
            break-after: page;
          }
        }

  `;
}

function PackingSlipPrintToolbar({
  eyebrow,
  title,
  description,
  formatLabel,
  format,
  letterLabel,
  thermalLabel,
  changeFormatLabel,
  printLabel,
  shipmentIds,
  shipmentIdFieldName = "shipmentIds",
  formatFieldName = "format",
}: PackingSlipPrintToolbarProps) {
  return (
    <div className="fulfillment-packing-slip-toolbar">
      <div className="fulfillment-packing-slip-toolbar__copy">
        <p className="fulfillment-packing-slip-toolbar__eyebrow">{eyebrow}</p>
        <h1 className="fulfillment-packing-slip-toolbar__title">{title}</h1>
        <p className="fulfillment-packing-slip-toolbar__description">{description}</p>
      </div>
      <div className="fulfillment-packing-slip-toolbar__actions">
        <Form className="fulfillment-packing-slip-toolbar__form" method="get" spacing="none">
          {shipmentIds.map((shipmentId) => (
            <HiddenInput key={shipmentId} name={shipmentIdFieldName} value={shipmentId} />
          ))}
          <NativeSelect
            name={formatFieldName}
            label={formatLabel}
            defaultValue={format}
            items={[
              { value: "letter", label: letterLabel },
              { value: "thermal-4x6", label: thermalLabel },
            ]}
          />
          <Button tone="secondary" type="submit">
            {changeFormatLabel}
          </Button>
        </Form>
        <Button type="button" onClick={() => globalThis.print?.()}>
          {printLabel}
        </Button>
      </div>
    </div>
  );
}

export function PackingSlipPrintDocument({ format, toolbar, slips, labels }: PackingSlipPrintDocumentProps) {
  return (
    <div className="fulfillment-packing-slip-page">
      <style dangerouslySetInnerHTML={{ __html: packingSlipPrintStyles(format) }} />
      <PackingSlipPrintToolbar {...toolbar} />

      <div className="fulfillment-packing-slip-print-root" data-format={format}>
        {slips.map((slip) => (
          <article
            key={slip.id}
            className={cx("fulfillment-packing-slip", printSizeClass(format))}
            data-packing-slip-page
          >
            <header className="fulfillment-packing-slip__header">
              <div>
                <h1 className="fulfillment-packing-slip__title">{labels.packingSlip}</h1>
                <div className="fulfillment-packing-slip__meta-line">
                  {labels.order}: {slip.orderReference}
                </div>
              </div>
              <div className="fulfillment-packing-slip__reference">
                <div>{slip.referenceLabel}</div>
                <div>{slip.referenceValue}</div>
              </div>
            </header>

            <section className="fulfillment-packing-slip__grid">
              <div>
                <h2 className="fulfillment-packing-slip__section-title">{slip.shipToTitle}</h2>
                {slip.shipToLines.map((line, index) => (
                  <div key={index} className="fulfillment-packing-slip__address-line">
                    {line}
                  </div>
                ))}
              </div>
              {slip.shipFromLines ? (
                <div>
                  <h2 className="fulfillment-packing-slip__section-title">{slip.shipFromTitle}</h2>
                  {slip.shipFromLines.map((line, index) => (
                    <div key={index} className="fulfillment-packing-slip__address-line">
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            <section>
              <h2 className="fulfillment-packing-slip__section-title">{slip.itemsTitle}</h2>
              <table className="fulfillment-packing-slip__table">
                <thead>
                  <tr>
                    <th>{labels.item}</th>
                    <th>{labels.product}</th>
                    <th className="fulfillment-packing-slip__qty">{labels.quantity}</th>
                  </tr>
                </thead>
                <tbody>
                  {slip.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <strong>{line.title}</strong>
                        {line.subtitle ? <div>{line.subtitle}</div> : null}
                      </td>
                      <td>{line.summary ?? labels.standardProduct}</td>
                      <td className="fulfillment-packing-slip__qty">{line.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <footer>
              <p className="fulfillment-packing-slip__footer">{slip.footer}</p>
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}
