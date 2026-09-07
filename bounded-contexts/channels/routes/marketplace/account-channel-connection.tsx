import AccountChannelConnectionRoute, {
  loader as loadAccountChannelConnection,
  meta as accountChannelConnectionMeta,
} from "../../features/outbound-sync/ui/account-channel-connection-route";

export const loader = loadAccountChannelConnection;
export const meta = accountChannelConnectionMeta;

export default function AccountChannelConnectionRouteAdapter() {
  return <AccountChannelConnectionRoute />;
}
