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
    await this.page.goto(`${testEnv.webBaseUrl}/account`);
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
    await form
      .getByLabel(/state\/province/i)
      .selectOption({ label: data.stateLabel });
    await form.getByLabel(/postal code/i).fill(data.postalCode);
  }

  async submitAddressForm(action: "save" | "update" = "save") {
    const buttonLabel = action === "save" ? /save address/i : /update address/i;
    await this.addressForm().getByRole("button", { name: buttonLabel }).click();
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
