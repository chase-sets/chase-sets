export const insightsDashboardRoutes = {
  salesPerformanceKpi: "/dashboards/sales-performance-kpi",
  fulfillmentLatencyKpi: "/dashboards/fulfillment-latency-kpi",
  conversionOrderKpi: "/dashboards/conversion-order-kpi",
} as const;

export const insightsDashboardQueryContracts = {
  salesPerformanceKpi: "insights.dashboards.sales-performance-kpi.query",
  fulfillmentLatencyKpi: "insights.dashboards.fulfillment-latency-kpi.query",
  conversionOrderKpi: "insights.dashboards.conversion-order-kpi.query",
} as const;
