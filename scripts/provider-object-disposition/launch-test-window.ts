import { pathToFileURL } from "node:url";
import { runTestWindow } from "./test-window-main.mjs";
import { validateCapturePacket } from "./test-window-packet.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runTestWindow();
  const packet = validateCapturePacket(result)
    ? result
    : {
        version: "provider-lifecycle-capture/v1",
        classification: "invalid",
        code: "packet-invalid",
        replayQualified: false,
      };
  process.stdout.write(JSON.stringify(packet) + "\n");
  process.exitCode = packet.classification === "observed" || packet.classification === "unknown" ? 0 : 2;
}
