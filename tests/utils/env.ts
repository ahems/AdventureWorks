import { execSync } from "child_process";

export interface TestEnvironment {
  webBaseUrl: string;
  functionsBaseUrl: string;
  restApiBaseUrl: string;
}

const getAzdEnvValue = (key: string): string | undefined => {
  try {
    const output = execSync(`azd env get-value "${key}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
};

const defaultEnv: TestEnvironment = {
  webBaseUrl:
    process.env.WEB_BASE_URL ||
    getAzdEnvValue("APP_REDIRECT_URI") ||
    "http://localhost:5173",
  functionsBaseUrl:
    process.env.FUNCTIONS_BASE_URL ||
    getAzdEnvValue("VITE_API_FUNCTIONS_URL") ||
    "http://localhost:7071",
  restApiBaseUrl:
    process.env.REST_API_BASE_URL ||
    getAzdEnvValue("VITE_API_URL")?.replace(/\/graphql\/?$/, "/api") ||
    "http://localhost:5000/api",
};

export const testEnv: TestEnvironment = defaultEnv;

export const APP_STORAGE_KEYS = {
  language: "adventureworks_language",
  currency: "adventureworks_currency",
  currentUser: "adventureworks_current_user",
};
