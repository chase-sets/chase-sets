export const insightsDashboardRoutes = {
  sellerPerformanceKpi: "/dashboards/seller-performance-kpi",
  fulfillmentLatencyKpi: "/dashboards/fulfillment-latency-kpi",
  conversionOrderKpi: "/dashboards/conversion-order-kpi",
} as const;

export const insightsDashboardQueryContracts = {
  sellerPerformanceKpi: "insights.dashboards.seller-performance-kpi.query",
  fulfillmentLatencyKpi: "insights.dashboards.fulfillment-latency-kpi.query",
  conversionOrderKpi: "insights.dashboards.conversion-order-kpi.query",
} as const;
