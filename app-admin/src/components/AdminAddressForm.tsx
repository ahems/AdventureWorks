import React, { useState, useEffect } from "react";
import { Save, X, Loader2 } from "lucide-react";
import { z } from "zod";
import type { Address } from "@/hooks/useAdminCustomerAddresses";
import { useCountriesAndStates } from "@/hooks/useCountriesAndStates";

const addressSchema = z.object({
  addressType: z.string().min(1, "Address type is required"),
  addressLine1: z
    .string()
    .min(1, "Address line 1 is required")
    .max(200, "Must be less than 200 characters"),
  addressLine2: z
    .string()
    .max(200, "Must be less than 200 characters")
    .optional(),
  city: z
    .string()
    .min(2, "City is required")
    .max(100, "Must be less than 100 characters"),
  countryRegionCode: z.string().min(1, "Country is required"),
  stateProvinceId: z.number().int().positive("State/Province is required"),
  postalCode: z.string().min(1, "Postal code is required"),
  isDefault: z.boolean(),
});

interface AdminAddressFormProps {
  address?: Address;
  onSave: (address: Omit<Address, "id">) => void | Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

export const AdminAddressForm: React.FC<AdminAddressFormProps> = ({
  address,
  onSave,
  onCancel,
  isSaving = false,
}) => {
  const [selectedCountry, setSelectedCountry] = useState(
    address?.countryRegionCode || "US",
  );
  const { countries, states, isCountriesLoading, isStatesLoading } =
    useCountriesAndStates(selectedCountry);

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

  const [errors, setErrors] = useState<Record<string, string>>({});

  // Default to first state once states load (for new form)
  useEffect(() => {
    if (states.length > 0 && formData.stateProvinceId === 0) {
      setFormData((prev) => ({
        ...prev,
        stateProvinceId: states[0].StateProvinceID,
      }));
    }
  }, [states, formData.stateProvinceId]);

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
      stateProvinceId: 0,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      addressSchema.parse(formData);
      setErrors({});
      await onSave(formData);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const newErrors: Record<string, string> = {};
        error.errors.forEach((e) => {
          if (e.path[0]) newErrors[e.path[0] as string] = e.message;
        });
        setErrors(newErrors);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Address Type */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Address Type *
        </label>
        <select
          value={formData.addressType}
          onChange={(e) => handleChange("addressType", e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="Home">Home (Default)</option>
          <option value="Shipping">Shipping</option>
          <option value="Billing">Billing</option>
          <option value="Main Office">Main Office</option>
          <option value="Primary">Primary</option>
          <option value="Archive">Archive</option>
        </select>
        {errors.addressType && (
          <p className="text-red-500 text-xs mt-1">{errors.addressType}</p>
        )}
      </div>

      {/* Address Line 1 */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Address Line 1 *
        </label>
        <input
          type="text"
          value={formData.addressLine1}
          onChange={(e) => handleChange("addressLine1", e.target.value)}
          placeholder="123 Main Street"
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {errors.addressLine1 && (
          <p className="text-red-500 text-xs mt-1">{errors.addressLine1}</p>
        )}
      </div>

      {/* Address Line 2 */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Address Line 2
        </label>
        <input
          type="text"
          value={formData.addressLine2}
          onChange={(e) => handleChange("addressLine2", e.target.value)}
          placeholder="Apt, Suite, Unit, etc."
          className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* City + Country */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            City *
          </label>
          <input
            type="text"
            value={formData.city}
            onChange={(e) => handleChange("city", e.target.value)}
            placeholder="Seattle"
            className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.city && (
            <p className="text-red-500 text-xs mt-1">{errors.city}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Country *
          </label>
          <select
            value={formData.countryRegionCode}
            onChange={(e) => handleCountryChange(e.target.value)}
            disabled={isCountriesLoading}
            className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="">Select Country</option>
            {countries.map((c) => (
              <option key={c.CountryRegionCode} value={c.CountryRegionCode}>
                {c.Name}
              </option>
            ))}
          </select>
          {errors.countryRegionCode && (
            <p className="text-red-500 text-xs mt-1">
              {errors.countryRegionCode}
            </p>
          )}
        </div>
      </div>

      {/* State + Postal Code */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            State / Province *
          </label>
          <select
            value={formData.stateProvinceId}
            onChange={(e) =>
              handleChange("stateProvinceId", parseInt(e.target.value))
            }
            disabled={isStatesLoading || states.length === 0}
            className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            <option value="0">Select State/Province</option>
            {states.map((s) => (
              <option key={s.StateProvinceID} value={s.StateProvinceID}>
                {s.Name} ({s.StateProvinceCode})
              </option>
            ))}
          </select>
          {errors.stateProvinceId && (
            <p className="text-red-500 text-xs mt-1">
              {errors.stateProvinceId}
            </p>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Postal Code *
          </label>
          <input
            type="text"
            value={formData.postalCode}
            onChange={(e) => handleChange("postalCode", e.target.value)}
            placeholder="98101"
            className="w-full border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.postalCode && (
            <p className="text-red-500 text-xs mt-1">{errors.postalCode}</p>
          )}
        </div>
      </div>

      {/* Is Default */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={formData.isDefault}
          onChange={(e) => handleChange("isDefault", e.target.checked)}
          className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
        />
        <span className="text-sm text-gray-700">Set as default address</span>
      </label>

      {/* Actions */}
      <div className="flex gap-2 pt-2">
        <button
          type="submit"
          disabled={isSaving}
          className="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {isSaving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {address ? "Update Address" : "Save Address"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1.5 border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
    </form>
  );
};
