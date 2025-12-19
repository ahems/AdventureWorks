import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Save } from "lucide-react";
import { z } from "zod";
import type { Address } from "@/hooks/useAddresses";
import { useCountriesAndStates } from "@/hooks/useCountriesAndStates";

interface AddressFormProps {
  address?: Address;
  onSave: (address: Omit<Address, "id">) => void;
  onCancel: () => void;
}

export const AddressForm: React.FC<AddressFormProps> = ({
  address,
  onSave,
  onCancel,
}) => {
  const { t } = useTranslation("common");

  const addressSchema = z.object({
    addressType: z.string().min(1, t("addressForm.addressTypeRequired")),
    addressLine1: z
      .string()
      .min(1, t("addressForm.addressLine1Required"))
      .max(200, t("addressForm.addressMustBeLessThan200Characters")),
    addressLine2: z
      .string()
      .max(200, t("addressForm.addressMustBeLessThan200Characters"))
      .optional(),
    city: z
      .string()
      .min(2, t("addressForm.cityRequired"))
      .max(100, t("addressForm.cityMustBeLessThan100Characters")),
    countryRegionCode: z.string().min(1, t("addressForm.countryRequired")),
    stateProvinceId: z
      .number()
      .int()
      .positive(t("addressForm.stateProvinceRequired")),
    postalCode: z.string().min(5, t("addressForm.postalCodeRequired")),
    isDefault: z.boolean(),
  });

  const [selectedCountry, setSelectedCountry] = useState(
    address?.countryRegionCode || "US"
  );
  const {
    countries,
    states,
    isLoading: isLoadingCountriesStates,
  } = useCountriesAndStates(selectedCountry);

  const [formData, setFormData] = useState({
    addressType: address?.addressType || "Home",
    addressLine1: address?.addressLine1 || "",
    addressLine2: address?.addressLine2 || "",
    city: address?.city || "",
    countryRegionCode: address?.countryRegionCode || "US",
    stateProvinceId: address?.stateProvinceId || 0,
    postalCode: address?.postalCode || "",
    isDefault: address?.isDefault || false,
  });

  // Set default state when states load
  useEffect(() => {
    if (states.length > 0 && formData.stateProvinceId === 0) {
      // Default to first state in list (typically alphabetically first)
      setFormData((prev) => ({
        ...prev,
        stateProvinceId: states[0].StateProvinceID,
      }));
    }
  }, [states, formData.stateProvinceId]);

  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (field: string, value: string | boolean | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const handleCountryChange = (countryCode: string) => {
    setSelectedCountry(countryCode);
    setFormData((prev) => ({
      ...prev,
      countryRegionCode: countryCode,
      stateProvinceId: 0, // Reset state when country changes
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    try {
      addressSchema.parse(formData);
      setErrors({});
      onSave(formData);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((err) => {
          if (err.path[0]) {
            newErrors[err.path[0] as string] = err.message;
          }
        });
        setErrors(newErrors);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          {t("addressForm.addressType")} *
        </label>
        <select
          value={formData.addressType}
          onChange={(e) => handleChange("addressType", e.target.value)}
          className="doodle-input w-full"
        >
          <option value="Home">{t("addressForm.home")}</option>
          <option value="Shipping">{t("addressForm.shipping")}</option>
          <option value="Billing">{t("addressForm.billing")}</option>
          <option value="Main Office">{t("addressForm.mainOffice")}</option>
          <option value="Primary">{t("addressForm.primary")}</option>
          <option value="Archive">{t("addressForm.archive")}</option>
        </select>
        {errors.addressType && (
          <p className="font-doodle text-xs text-doodle-accent mt-1">
            {errors.addressType}
          </p>
        )}
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          {t("addressForm.addressLine1")} *
        </label>
        <input
          type="text"
          value={formData.addressLine1}
          onChange={(e) => handleChange("addressLine1", e.target.value)}
          className="doodle-input w-full"
          placeholder={t("addressForm.addressLine1Placeholder")}
        />
        {errors.addressLine1 && (
          <p className="font-doodle text-xs text-doodle-accent mt-1">
            {errors.addressLine1}
          </p>
        )}
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          {t("addressForm.addressLine2")}
        </label>
        <input
          type="text"
          value={formData.addressLine2}
          onChange={(e) => handleChange("addressLine2", e.target.value)}
          className="doodle-input w-full"
          placeholder={t("addressForm.addressLine2Placeholder")}
        />
        {errors.addressLine2 && (
          <p className="font-doodle text-xs text-doodle-accent mt-1">
            {errors.addressLine2}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            {t("addressForm.city")} *
          </label>
          <input
            type="text"
            value={formData.city}
            onChange={(e) => handleChange("city", e.target.value)}
            className="doodle-input w-full"
            placeholder={t("addressForm.cityPlaceholder")}
          />
          {errors.city && (
            <p className="font-doodle text-xs text-doodle-accent mt-1">
              {errors.city}
            </p>
          )}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            {t("addressForm.country")} *
          </label>
          <select
            value={formData.countryRegionCode}
            onChange={(e) => handleCountryChange(e.target.value)}
            className="doodle-input w-full"
            disabled={isLoadingCountriesStates}
          >
            <option value="">{t("addressForm.selectCountry")}</option>
            {countries.map((country) => (
              <option
                key={country.CountryRegionCode}
                value={country.CountryRegionCode}
              >
                {country.Name}
              </option>
            ))}
          </select>
          {errors.countryRegionCode && (
            <p className="font-doodle text-xs text-doodle-accent mt-1">
              {errors.countryRegionCode}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            {t("addressForm.stateProvince")} *
          </label>
          <select
            value={formData.stateProvinceId}
            onChange={(e) =>
              handleChange("stateProvinceId", parseInt(e.target.value))
            }
            className="doodle-input w-full"
            disabled={isLoadingCountriesStates || states.length === 0}
          >
            <option value="0">{t("addressForm.selectStateProvince")}</option>
            {states.map((state) => (
              <option key={state.StateProvinceID} value={state.StateProvinceID}>
                {state.Name} ({state.StateProvinceCode})
              </option>
            ))}
          </select>
          {errors.stateProvinceId && (
            <p className="font-doodle text-xs text-doodle-accent mt-1">
              {errors.stateProvinceId}
            </p>
          )}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            {t("addressForm.postalCode")} *
          </label>
          <input
            type="text"
            value={formData.postalCode}
            onChange={(e) => handleChange("postalCode", e.target.value)}
            className="doodle-input w-full"
            placeholder={t("addressForm.postalCodePlaceholder")}
          />
          {errors.postalCode && (
            <p className="font-doodle text-xs text-doodle-accent mt-1">
              {errors.postalCode}
            </p>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={formData.isDefault}
          onChange={(e) => handleChange("isDefault", e.target.checked)}
          className="w-4 h-4"
        />
        <span className="font-doodle text-sm text-doodle-text">
          {t("addressForm.setAsDefaultAddress")}
        </span>
      </label>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          className="doodle-button doodle-button-primary flex-1 flex items-center justify-center gap-2"
        >
          <Save className="w-4 h-4" />
          {address
            ? t("addressForm.updateAddress")
            : t("addressForm.saveAddress")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="doodle-button flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          {t("addressForm.cancel")}
        </button>
      </div>
    </form>
  );
};
