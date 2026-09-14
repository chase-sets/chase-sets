import { loader as connectionLoader } from "../../features/connections/ui/account-channels-connection-route-adapter";

export {
  action,
  clientAction,
  default,
  downloadAction,
  meta,
  readActionError,
} from "../../features/connections/ui/account-channels-connection-route-adapter";

export const loader = connectionLoader;
