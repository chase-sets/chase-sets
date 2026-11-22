// Keep the declared support path for compatibility; feature callers use the local request client.
export {
  createNotificationCenterProductAlertsRequestClient,
  createNotificationCenterRequestApiClient,
  NotificationCenterProductAlertsReadError,
  type NotificationCenterProductAlert,
  type NotificationCenterProductAlertList,
} from "../../features/notification-center/api/request-client";
