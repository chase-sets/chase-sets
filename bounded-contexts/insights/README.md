# Insights Bounded Context

## Purpose

Insights owns cross-context reporting, analytics, and forecasting views.

## Owns

- Analytical projections
- Seller dashboards
- Buyer and seller performance metrics
- Forecast models
- Operational KPIs

## Does Not Own

- Transactional decisions
- Order lifecycle invariants
- Payment authorizations

## Ubiquitous Language

Insights terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Analytical Projection
- KPI Definition
- Forecast Model
- Dashboard View

## Incoming Dependencies

- Integration events from every transactional bounded context

## Outgoing Integration Events

- `DashboardRefreshed`
- `ForecastPublished`
- `KpiThresholdExceeded`

## Invariants

1. Insights is downstream and projection-oriented.
2. Insights must not become a hidden transaction coordinator.
3. Reports may join data across contexts, but source transactional ownership does not move.
4. Forecasting outputs are advisory unless another context explicitly consumes them.

## Open Extraction Candidates

- Merchant BI can be extracted later if self-serve analytics becomes a product area with distinct lifecycle and permissions.


## Advisory and Read-Only Design

- Insights ingests published integration events from transactional contexts and materializes dashboard read models.
- Insights does **not** expose command handlers that mutate upstream transactional contexts.
- Insights outputs are advisory and query-only by design.
