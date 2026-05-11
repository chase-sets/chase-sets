export function getPlatformSmokeCliArgs(argv) {
  const args = argv.slice(2);

  return args[0] === "--" ? args.slice(1) : args;
}
