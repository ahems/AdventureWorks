/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Runtime configuration injected by Docker entrypoint
interface AppConfig {
  API_URL: string;
  API_FUNCTIONS_URL?: string;
  APPINSIGHTS_CONNECTIONSTRING?: string;
}

interface Window {
  APP_CONFIG?: AppConfig;
}
