export type WorkspaceSourceAlias = Readonly<{
  find: string | RegExp;
  replacement: string;
}>;

export function createWorkspaceSourceAliases(): WorkspaceSourceAlias[];
