import "@chase-sets/design-system/styles.css";
import ReactDOM from "react-dom/client";
import { App } from "./app";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element.");
}

ReactDOM.createRoot(root).render(<App />);
