import { Page, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";
import { APP_STORAGE_KEYS, testEnv } from "./env";

export interface TestAccount {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  businessEntityId: number;
}

interface SignupOverrides {
  email?: string;
  password?: string;
}

export const createRandomCredentials = (
  overrides: SignupOverrides = {},
): Omit<TestAccount, "businessEntityId"> => {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email =
    overrides.email || faker.internet.email({ firstName, lastName });
  const password = overrides.password || `Aw${faker.string.alphanumeric(8)}!9`;

  return { firstName, lastName, email, password };
};

const seedLocaleStorage = async (
  page: Page,
  options: { clearUser?: boolean } = {},
) => {
  const { clearUser = false } = options;
  // Use addInitScript but with a one-time flag to avoid clearing user on subsequent navigations
  await page.addInitScript(
    ({ languageKey, currencyKey, currentUserKey, shouldClearUser }) => {
      localStorage.setItem(languageKey, "en");
      localStorage.setItem(currencyKey, "USD");
      // Only clear user if explicitly requested AND if not already cleared
      if (shouldClearUser && !sessionStorage.getItem("user_cleared")) {
        localStorage.removeItem(currentUserKey);
        sessionStorage.setItem("user_cleared", "true");
      }
    },
    {
      languageKey: APP_STORAGE_KEYS.language,
      currencyKey: APP_STORAGE_KEYS.currency,
      currentUserKey: APP_STORAGE_KEYS.currentUser,
      shouldClearUser: clearUser,
    },
  );
};

export const signupThroughUi = async (
  page: Page,
  overrides: SignupOverrides = {},
): Promise<TestAccount> => {
  const creds = createRandomCredentials(overrides);
  await seedLocaleStorage(page, { clearUser: true });
  await page.goto(`${testEnv.webBaseUrl}/auth`);

  const toggleButton = page
    .getByRole("button", { name: /create one here/i })
    .first();
  await toggleButton.click();

  await page.getByLabel(/first name/i).fill(creds.firstName);
  await page.getByLabel(/last name/i).fill(creds.lastName);
  await page.getByLabel(/email address/i).fill(creds.email);
  await page.getByLabel(/^password$/i).fill(creds.password);
  await page.getByLabel(/confirm password/i).fill(creds.password);

  await page.getByRole("button", { name: /create account/i }).click();

  // Wait for user to be stored in localStorage after signup
  // Increased timeout to 60s to allow for Azure Functions cold start
  await page.waitForFunction(
    (key) => {
      const stored = localStorage.getItem(key);
      return stored !== null;
    },
    APP_STORAGE_KEYS.currentUser,
    { timeout: 60000 },
  );

  // Navigate to home page after successful signup
  await page.goto(testEnv.webBaseUrl);
  await page.waitForLoadState("domcontentloaded");

  const storedUser = await page.evaluate((key) => {
    return localStorage.getItem(key);
  }, APP_STORAGE_KEYS.currentUser);

  expect(storedUser, "User should be persisted after signup").toBeTruthy();
  const parsedUser = JSON.parse(storedUser!);

  console.log(
    `\n📧 Test User Created:\n   Email: ${creds.email}\n   Password: ${creds.password}\n`,
  );

  return {
    ...creds,
    businessEntityId: Number(parsedUser.businessEntityId || parsedUser.id),
  };
};

export const logoutFromAccount = async (page: Page) => {
  await Promise.all([
    page.waitForURL("**/", { timeout: 10000 }),
    page.getByRole("button", { name: /sign out/i }).click(),
  ]);
};

export const loginThroughUi = async (
  page: Page,
  email: string,
  password: string,
) => {
  await seedLocaleStorage(page);
  await page.goto(`${testEnv.webBaseUrl}/auth`);
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/");
};

export const expectLoginFailure = async (
  page: Page,
  email: string,
  password: string,
) => {
  await seedLocaleStorage(page);
  await page.goto(`${testEnv.webBaseUrl}/auth`);
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(
    page.getByText(/invalid email or password/i).first(),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/auth/);
};
