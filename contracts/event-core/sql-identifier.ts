const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSqlIdentifier(identifier: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new Error(
      `Invalid SQL identifier "${identifier}". Use letters, numbers, and underscores only.`,
    );
  }

  return identifier;
}
