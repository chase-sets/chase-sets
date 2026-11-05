async function settle(): Promise<void> {}

export async function awaited(): Promise<void> {
  await settle();
}

export function caught(report: (error: unknown) => void): void {
  settle().catch(report);
}

export function dropped(): void {
  settle();
}
