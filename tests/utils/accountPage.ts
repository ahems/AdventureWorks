import { expect, Locator, Page } from "@playwright/test";
import { testEnv } from "./env";

export interface AddressInput {
  addressType?: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateLabel: string;
  postalCode: string;
  country: string;
}

export class AccountPage {
  constructor(private readonly page: Page) {}

  async goto() {
    // Debug: check localStorage before navigation
    const userBeforeNav = await this.page.evaluate(() => {
      return localStorage.getItem("adventureworks_current_user");
    });
    console.log(
      "User in localStorage before /account navigation:",
      userBeforeNav,
    );

    await this.page.goto(`${testEnv.webBaseUrl}/account`);

    // Debug: check URL after navigation and localStorage
    console.log("URL after /account navigation:", this.page.url());
    const userAfterNav = await this.page.evaluate(() => {
      return localStorage.getItem("adventureworks_current_user");
    });
    console.log(
      "User in localStorage after /account navigation:",
      userAfterNav,
    );

    await expect(
      this.page.getByRole("heading", { name: /saved addresses/i }),
    ).toBeVisible();
  }

  private addressForm(): Locator {
    return this.page.getByTestId("address-form");
  }

  async openAddressForm() {
    const toggleButton = this.page.getByTestId("add-address-button").first();
    await toggleButton.click();
    await expect(this.addressForm()).toBeVisible();
  }

  async fillAddressForm(data: AddressInput) {
    const form = this.addressForm();
    if (data.addressType) {
      await form
        .getByLabel(/address type/i)
        .selectOption({ label: data.addressType });
    }
    await form.getByLabel(/address line 1/i).fill(data.addressLine1);
    if (data.addressLine2 !== undefined) {
      await form.getByLabel(/address line 2/i).fill(data.addressLine2);
    }
    await form.getByLabel(/city/i).fill(data.city);
    await form.getByLabel(/country/i).selectOption({ label: data.country });

    // Wait for state/province options to load after country selection
    const stateSelect = form.getByLabel(/state\/province/i);
    await stateSelect.waitFor({ state: "visible" });
    // Wait for options to populate (check that there's more than just the placeholder)
    await this.page.waitForFunction(
      (selectId) => {
        const select = document.querySelector(
          `#${selectId}`,
        ) as HTMLSelectElement;
        return select && select.options.length > 1;
      },
      "stateProvince",
      { timeout: 5000 },
    );

    // Debug: log available state options
    const availableStates = await stateSelect.evaluate(
      (select: HTMLSelectElement) =>
        Array.from(select.options).map((o) => o.text),
    );
    console.log("Available states:", availableStates);
    console.log("Looking for:", data.stateLabel);

    await stateSelect.selectOption({ label: data.stateLabel });
    await form.getByLabel(/postal code/i).fill(data.postalCode);
  }

  async submitAddressForm(action: "save" | "update" = "save") {
    const buttonLabel = action === "save" ? /save address/i : /update address/i;
    await this.addressForm().getByRole("button", { name: buttonLabel }).click();
    // Wait for form to close after submission
    await expect(this.addressForm()).not.toBeVisible({ timeout: 10000 });
  }

  findAddressCard(matcher: string): Locator {
    return this.page
      .getByTestId("address-card")
      .filter({ hasText: matcher })
      .first();
  }

  async expectAddressVisible(matcher: string) {
    await expect(this.findAddressCard(matcher)).toBeVisible();
  }

  async editAddress(matcher: string) {
    const card = this.findAddressCard(matcher);
    await card.getByTestId("address-edit-button").click();
    await expect(this.addressForm()).toBeVisible();
  }

  async deleteAddress(matcher: string) {
    const card = this.findAddressCard(matcher);
    const [dialog] = await Promise.all([
      this.page.waitForEvent("dialog"),
      card.getByTestId("address-delete-button").click(),
    ]);
    await dialog.accept();
    await expect(card).toBeHidden();
  }
}
