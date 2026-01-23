import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";
import {
  signupThroughUi,
  logoutFromAccount,
  expectLoginFailure,
  loginThroughUi,
} from "../utils/testUser";
import { AccountPage } from "../utils/accountPage";

test.describe("Password Azure Functions", () => {
  test("user can change password and authenticate with the new secret", async ({
    page,
  }) => {
    const user = await signupThroughUi(page);
    const accountPage = new AccountPage(page);
    await accountPage.goto();

    await page.getByTestId("account-settings-toggle").click();

    const newPassword = `Aw${faker.string.alphanumeric(8)}!7`;
    console.log(
      `\n🔐 Changing Password:\n   Email: ${user.email}\n   Old Password: ${user.password}\n   New Password: ${newPassword}\n`,
    );

    await page.getByLabel(/current password/i).fill(user.password);
    await page.getByLabel(/^new password$/i).fill(newPassword);
    await page.getByLabel(/confirm new password/i).fill(newPassword);

    await page.getByRole("button", { name: /change password/i }).click();

    await expect(
      page.getByText(/your password has been updated successfully/i).first(),
    ).toBeVisible();

    await logoutFromAccount(page);

    await expectLoginFailure(page, user.email, user.password);

    await loginThroughUi(page, user.email, newPassword);
    await expect(page).not.toHaveURL(/auth/);
  });
});
