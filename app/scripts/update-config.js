#!/usr/bin/env node

// Update config.js with the API URL from environment variable
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const API_URL = process.env.VITE_API_URL || "http://localhost:5000/graphql";
const API_FUNCTIONS_URL =
  process.env.VITE_API_FUNCTIONS_URL || "http://localhost:7071";
const APPINSIGHTS_CONNECTIONSTRING =
  process.env.VITE_APPINSIGHTS_CONNECTIONSTRING || "";

console.log("[Build] Updating config.js with API_URL:", API_URL);
console.log(
  "[Build] Updating config.js with API_FUNCTIONS_URL:",
  API_FUNCTIONS_URL
);
console.log(
  "[Build] Updating config.js with APPINSIGHTS_CONNECTIONSTRING:",
  APPINSIGHTS_CONNECTIONSTRING ? "Set" : "Not set"
);

const configContent = `// Runtime configuration
// Generated during build process
window.APP_CONFIG = {
  API_URL: '${API_URL}',
  API_FUNCTIONS_URL: '${API_FUNCTIONS_URL}',
  APPINSIGHTS_CONNECTIONSTRING: '${APPINSIGHTS_CONNECTIONSTRING}'
};
`;

const configPath = path.join(__dirname, "..", "public", "config.js");

try {
  fs.writeFileSync(configPath, configContent, "utf8");
  console.log("[Build] Successfully wrote config.js");
} catch (error) {
  console.error("[Build] Failed to write config.js:", error);
  process.exit(1);
}
