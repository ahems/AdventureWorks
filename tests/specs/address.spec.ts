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
});
