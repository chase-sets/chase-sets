type SnapshotState = Readonly<{
  status: string;
}>;

export function commandSnapshotResponse<State extends SnapshotState>(
  id: string,
  result: Readonly<{ version: number; state: State }>,
) {
  return {
    id,
    version: result.version,
    status: result.state.status,
    snapshot: result.state,
  };
}
