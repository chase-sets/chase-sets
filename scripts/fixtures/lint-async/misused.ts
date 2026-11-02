function onEvent(listener: () => void): void {
  listener();
}

export function registered(): void {
  onEvent(() => {});
}

export function misused(): void {
  onEvent(async () => {});
}
