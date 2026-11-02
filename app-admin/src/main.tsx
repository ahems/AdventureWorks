import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initAppInsights } from "./lib/appInsights";

initAppInsights();

createRoot(document.getElementById("root")!).render(<App />);
