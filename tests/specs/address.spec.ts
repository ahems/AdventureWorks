import { test, expect } from "@playwright/test";
import { faker } from "@faker-js/faker";
import { signupThroughUi } from "../utils/testUser";
import { AccountPage } from "../utils/accountPage";

const US_STATES = [
  { label: "Washington (WA )", abbrev: "WA" },
  { label: "Oregon (OR )", abbrev: "OR" },
  { label: "California (CA )", abbrev: "CA" },
  { label: "Texas (TX )", abbrev: "TX" },
  { label: "New York (NY )", abbrev: "NY" },
];

const createRandomAddress = () => {
  const state = faker.helpers.arrayElement(US_STATES);
  return {
    addressLine1: `${faker.location.buildingNumber()} ${faker.location.street()}`,
    addressLine2:
      faker.helpers.maybe(
        () => `Suite ${faker.number.int({ min: 100, max: 999 })}`,
        { probability: 0.5 },
      ) || "",
    city: faker.location.city(),
    stateLabel: state.label,
    postalCode: faker.location.zipCode("#####"),
    country: "United States",
  };
};

test.describe("Address Azure Functions", () => {
  test("user can add, edit, and delete addresses via Azure Functions", async ({
    page,
  }) => {
    await signupThroughUi(page);
    const accountPage = new AccountPage(page);

    // Generate unique addresses for this test run
    const baseAddress = createRandomAddress();
    const updatedAddress = createRandomAddress();

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

  test("only one address can be set as default at a time", async ({ page }) => {
    // Capture console logs
    page.on("console", (msg) => console.log(`BROWSER: ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`PAGE ERROR: ${err.message}`));

    await signupThroughUi(page);
    const accountPage = new AccountPage(page);

    // Generate three unique addresses
    const address1 = createRandomAddress();
    const address2 = createRandomAddress();
    const address3 = createRandomAddress();

    await accountPage.goto();

    // Add first address
    await accountPage.openAddressForm();
    await accountPage.fillAddressForm(address1);
    await accountPage.submitAddressForm("save");
    await accountPage.expectAddressVisible(address1.addressLine1);

    // First address should be default (as it's the only one)
    await accountPage.expectAddressIsDefault(address1.addressLine1);

    // Add second address
    await accountPage.openAddressForm();
    await accountPage.fillAddressForm(address2);
    await accountPage.submitAddressForm("save");
    await accountPage.expectAddressVisible(address2.addressLine1);

    // First address should still be default
    await accountPage.expectAddressIsDefault(address1.addressLine1);
    await accountPage.expectAddressIsNotDefault(address2.addressLine1);

    console.log("=== After adding 2 addresses ===");
    console.log(`Address 1 (${address1.addressLine1}): Should be DEFAULT`);
    console.log(`Address 2 (${address2.addressLine1}): Should be NOT DEFAULT`);

    // Add third address
    await accountPage.openAddressForm();
    await accountPage.fillAddressForm(address3);
    await accountPage.submitAddressForm("save");
    await accountPage.expectAddressVisible(address3.addressLine1);

    // First address should still be default
    await accountPage.expectAddressIsDefault(address1.addressLine1);
    await accountPage.expectAddressIsNotDefault(address2.addressLine1);
    await accountPage.expectAddressIsNotDefault(address3.addressLine1);

    // Set second address as default
    await accountPage.setDefaultAddress(address2.addressLine1);

    // Check if an error toast appeared
    const errorToast = page.getByText(/failed to update default address/i);
    if (await errorToast.isVisible()) {
      console.log("ERROR TOAST IS VISIBLE - setDefaultAddress failed!");
    }

    // Now only second address should be default
    await accountPage.expectAddressIsNotDefault(address1.addressLine1);
    await accountPage.expectAddressIsDefault(address2.addressLine1);
    await accountPage.expectAddressIsNotDefault(address3.addressLine1);

    // Set third address as default
    await accountPage.setDefaultAddress(address3.addressLine1);

    // Now only third address should be default
    await accountPage.expectAddressIsNotDefault(address1.addressLine1);
    await accountPage.expectAddressIsNotDefault(address2.addressLine1);
    await accountPage.expectAddressIsDefault(address3.addressLine1);

    // Verify that the set-default button doesn't show for the default address
    const defaultCard = accountPage.findAddressCard(address3.addressLine1);
    await expect(
      defaultCard.getByTestId("address-set-default-button"),
    ).not.toBeVisible();

    // Verify that the set-default button shows for non-default addresses
    const nonDefaultCard = accountPage.findAddressCard(address1.addressLine1);
    await expect(
      nonDefaultCard.getByTestId("address-set-default-button"),
    ).toBeVisible();
  });
});
