import { installOperatorBridge, type OperatorCommand } from "@chase-sets/catalog/client";

const frame = document.querySelector("iframe");
if (frame)
  installOperatorBridge(window, frame, (message) => {
    if (message.action === "copy-probe-report")
      return navigator.clipboard.writeText(message.text).then(
        () => true,
        () => false,
      );
    return chrome.runtime.sendMessage(message as OperatorCommand);
  });
