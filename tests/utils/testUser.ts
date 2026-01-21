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
  await page.addInitScript(
    ({ languageKey, currencyKey, currentUserKey, shouldClearUser }) => {
      localStorage.setItem(languageKey, "en");
      localStorage.setItem(currencyKey, "USD");
      if (shouldClearUser) {
        localStorage.removeItem(currentUserKey);
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

  await page.getByRole("button", { name: /sign up/i }).click();
  await page.waitForURL("**/");

  const storedUser = await page.evaluate((key) => {
    return localStorage.getItem(key);
  }, APP_STORAGE_KEYS.currentUser);

  expect(storedUser, "User should be persisted after signup").toBeTruthy();
  const parsedUser = JSON.parse(storedUser!);

  return {
    ...creds,
    businessEntityId: Number(parsedUser.businessEntityId || parsedUser.id),
  };
};

export const logoutFromAccount = async (page: Page) => {
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.waitForURL("**/");
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
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/auth/);
};
