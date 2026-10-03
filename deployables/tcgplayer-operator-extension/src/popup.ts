import { installOperatorBridge } from "@chase-sets/catalog/client";

const frame = document.querySelector("iframe");
if (frame) installOperatorBridge(window, frame, (command) => chrome.runtime.sendMessage(command));
