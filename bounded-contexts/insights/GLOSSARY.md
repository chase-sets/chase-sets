# Insights Domain Glossary

This glossary defines the canonical terminology for the Insights bounded context.

## Analytical Projection

An **Analytical Projection** is a read model built from integration events across multiple bounded contexts.

## KPI

A **KPI** is a named metric used to track marketplace or account performance.

The canonical KPI terms and code contracts are:

| KPI term | Query contract | Route contract |
| --- | --- | --- |
| Seller Performance KPI | `insights.dashboards.seller-performance-kpi.query` | `/dashboards/seller-performance-kpi` |
| Fulfillment Latency KPI | `insights.dashboards.fulfillment-latency-kpi.query` | `/dashboards/fulfillment-latency-kpi` |
| Conversion Order KPI | `insights.dashboards.conversion-order-kpi.query` | `/dashboards/conversion-order-kpi` |

## Dashboard View

A **Dashboard View** is the presentation-focused projection used to render operational or commercial reporting.

## Forecast Model

A **Forecast Model** is the analytical model used to estimate future demand, pricing, or operational outcomes.

## Report Slice

A **Report Slice** is a filtered analytical view scoped by time, account, or product dimensions.
