import { test, expect } from "@playwright/test";
import { signupThroughUi } from "../utils/testUser";
import { AccountPage } from "../utils/accountPage";

const baseAddress = {
  addressLine1: "123 Summit Trail",
  addressLine2: "Suite 200",
  city: "Seattle",
  stateLabel: "Washington (WA)",
  postalCode: "98101",
  country: "United States",
};

const updatedAddress = {
  addressLine1: "456 Ridgecrest Ave",
  addressLine2: "",
  city: "Portland",
  stateLabel: "Oregon (OR)",
  postalCode: "97201",
  country: "United States",
};

test.describe("Address Azure Functions", () => {
  test("user can add, edit, and delete addresses via Azure Functions", async ({
    page,
  }) => {
    await signupThroughUi(page);
    const accountPage = new AccountPage(page);

    await accountPage.goto();
    await accountPage.openAddressForm();
    await accountPage.fillAddressForm(baseAddress);
    await accountPage.submitAddressForm("save");

    await accountPage.expectAddressVisible(baseAddress.addressLine1);

    await accountPage.editAddress(baseAddress.addressLine1);
    await accountPage.fillAddressForm(updatedAddress);
    await accountPage.submitAddressForm("update");
    await accountPage.expectAddressVisible(updatedAddress.addressLine1);

    await accountPage.deleteAddress(updatedAddress.addressLine1);
    await expect(page.getByText(/no saved addresses yet/i)).toBeVisible();
  });
});
