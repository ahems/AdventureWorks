import { execSync } from "child_process";

export interface TestEnvironment {
  webBaseUrl: string;
  adminWebBaseUrl: string;
  functionsBaseUrl: string;
  restApiBaseUrl: string;
}

const getAzdEnvValue = (key: string): string | undefined => {
  try {
    const output = execSync(`azd env get-value "${key}" --no-prompt`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
};

const requireUrl = (envVar: string, azdKey: string, transform: (value: string) => string = (v) => v): string => {
  const value = process.env[envVar] || getAzdEnvValue(azdKey);
  if (!value) {
    throw new Error(
      `${envVar} is not set and azd value ${azdKey} is unavailable. ` +
        "Select a deployed azd environment (azd env select) or set the variable explicitly.",
    );
  }
  return transform(value);
};

// Resolved lazily so a script only needs the deployment URLs it actually uses.
export const testEnv: TestEnvironment = {
  get webBaseUrl() {
    return requireUrl("WEB_BASE_URL", "APP_URL");
  },
  get adminWebBaseUrl() {
    return requireUrl("ADMIN_WEB_BASE_URL", "APP_ADMIN_URL");
  },
  get functionsBaseUrl() {
    return requireUrl("FUNCTIONS_BASE_URL", "API_FUNCTIONS_URL");
  },
  get restApiBaseUrl() {
    return requireUrl("REST_API_BASE_URL", "API_URL", (v) => v.replace(/\/graphql\/?$/, "/api"));
  },
};

export const APP_STORAGE_KEYS = {
  language: "adventureworks_language",
  currency: "adventureworks_currency",
  currentUser: "adventureworks_current_user",
};

export const ADMIN_STORAGE_KEYS = {
  currentUser: "aw_current_admin_user",
};
