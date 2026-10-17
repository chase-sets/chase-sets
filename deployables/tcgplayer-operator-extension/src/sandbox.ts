import { renderOperatorExtensionPopup } from "@chase-sets/catalog/client";
import "@chase-sets/design-system/styles.css";
import { operatorExtensionId } from "./manifest-contract";

const root = document.getElementById("root");
if (root) renderOperatorExtensionPopup(root, `chrome-extension://${operatorExtensionId}`);
