import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initAppInsights } from "./lib/appInsights";
import { installFunctionsAuthInterceptor } from "./services/functionsAuthInterceptor";

initAppInsights();
installFunctionsAuthInterceptor();

createRoot(document.getElementById("root")!).render(<App />);
