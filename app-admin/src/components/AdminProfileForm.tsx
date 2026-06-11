import React, { useState, useEffect } from "react";
import { Save, X, Loader2 } from "lucide-react";
import {
  useAdminCustomerProfile,
  useAdminUpdateCustomerProfile,
} from "@/hooks/useAdminCustomerProfile";
import { parsePhoneNumber } from "@/lib/phoneFormatter";

interface AdminProfileFormProps {
  businessEntityId: number;
  onSaved: () => void;
  onCancel: () => void;
}

const PHONE_TYPE_OPTIONS = [
  { value: 1, label: "Cell" },
  { value: 2, label: "Home" },
  { value: 3, label: "Work" },
];

const COUNTRY_CODES = [
  { code: "1", flag: "🇺🇸", country: "US" },
  { code: "44", flag: "🇬🇧", country: "GB" },
  { code: "49", flag: "🇩🇪", country: "DE" },
  { code: "33", flag: "🇫🇷", country: "FR" },
  { code: "61", flag: "🇦🇺", country: "AU" },
  { code: "1", flag: "🇨🇦", country: "CA" },
];

export const AdminProfileForm: React.FC<AdminProfileFormProps> = ({
  businessEntityId,
  onSaved,
  onCancel,
}) => {
  const { data: profileData, isLoading: isLoadingProfile } =
    useAdminCustomerProfile(businessEntityId);
  const { mutateAsync: updateProfile, isPending: isSaving } =
    useAdminUpdateCustomerProfile();

  const [formData, setFormData] = useState({
    Title: "",
    FirstName: "",
    MiddleName: "",
    LastName: "",
    Suffix: "",
    EmailAddress: "",
    phoneCountryCode: "1",
    phoneLocalNumber: "",
    PhoneNumberTypeID: 1,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (profileData) {
      const { countryCode, localNumber } = parsePhoneNumber(
        profileData.PhoneNumber || "",
      );
      setFormData({
        Title: profileData.Title || "",
        FirstName: profileData.FirstName || "",
        MiddleName: profileData.MiddleName || "",
        LastName: profileData.LastName || "",
        Suffix: profileData.Suffix || "",
        EmailAddress: profileData.EmailAddress || "",
        phoneCountryCode: countryCode || "1",
        phoneLocalNumber: localNumber || "",
        PhoneNumberTypeID: profileData.PhoneNumberTypeID || 1,
      });
    }
  }, [profileData]);

  const handleChange = (field: string, value: string | number) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: "" }));
    }
  };

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.FirstName.trim())
      newErrors.FirstName = "First name is required";
    if (!formData.LastName.trim()) newErrors.LastName = "Last name is required";
    if (!formData.EmailAddress.trim()) {
      newErrors.EmailAddress = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.EmailAddress)) {
      newErrors.EmailAddress = "Enter a valid email address";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate() || !profileData) return;

    const phoneNumber = formData.phoneLocalNumber
      ? `+${formData.phoneCountryCode} ${formData.phoneLocalNumber}`
      : null;

    await updateProfile({
      BusinessEntityID: businessEntityId,
      Title: formData.Title || null,
      FirstName: formData.FirstName,
      MiddleName: formData.MiddleName || null,
      LastName: formData.LastName,
      Suffix: formData.Suffix || null,
      EmailAddress: formData.EmailAddress,
      EmailAddressID: profileData.EmailAddressID,
      PhoneNumber: phoneNumber,
      PhoneNumberTypeID: formData.PhoneNumberTypeID,
    });

    onSaved();
  };

  if (isLoadingProfile) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Title + First + Middle + Last + Suffix */}
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Title
          </label>
          <select
            value={formData.Title}
            onChange={(e) => handleChange("Title", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">None</option>
            <option value="Mr.">Mr.</option>
            <option value="Ms.">Ms.</option>
            <option value="Mrs.">Mrs.</option>
            <option value="Dr.">Dr.</option>
          </select>
        </div>
        <div className="col-span-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            First Name *
          </label>
          <input
            type="text"
            value={formData.FirstName}
            onChange={(e) => handleChange("FirstName", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.FirstName && (
            <p className="text-red-500 text-xs mt-1">{errors.FirstName}</p>
          )}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Middle Name
          </label>
          <input
            type="text"
            value={formData.MiddleName}
            onChange={(e) => handleChange("MiddleName", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="col-span-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Last Name *
          </label>
          <input
            type="text"
            value={formData.LastName}
            onChange={(e) => handleChange("LastName", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {errors.LastName && (
            <p className="text-red-500 text-xs mt-1">{errors.LastName}</p>
          )}
        </div>
        <div className="col-span-2">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Suffix
          </label>
          <select
            value={formData.Suffix}
            onChange={(e) => handleChange("Suffix", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">None</option>
            <option value="Jr.">Jr.</option>
            <option value="Sr.">Sr.</option>
            <option value="II">II</option>
            <option value="III">III</option>
            <option value="IV">IV</option>
          </select>
        </div>
      </div>

      {/* Email */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">
          Email *
        </label>
        <input
          type="email"
          value={formData.EmailAddress}
          onChange={(e) => handleChange("EmailAddress", e.target.value)}
          className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {errors.EmailAddress && (
          <p className="text-red-500 text-xs mt-1">{errors.EmailAddress}</p>
        )}
      </div>

      {/* Phone */}
      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Country Code
          </label>
          <select
            value={formData.phoneCountryCode}
            onChange={(e) => handleChange("phoneCountryCode", e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {COUNTRY_CODES.map((c) => (
              <option key={`${c.code}-${c.country}`} value={c.code}>
                {c.flag} +{c.code} ({c.country})
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-6">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Phone Number
          </label>
          <input
            type="tel"
            value={formData.phoneLocalNumber}
            onChange={(e) => handleChange("phoneLocalNumber", e.target.value)}
            placeholder="555-867-5309"
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="col-span-3">
          <label className="block text-xs font-medium text-gray-700 mb-1">
            Phone Type
          </label>
          <select
            value={formData.PhoneNumberTypeID}
            onChange={(e) =>
              handleChange("PhoneNumberTypeID", parseInt(e.target.value))
            }
            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {PHONE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

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
          Save Changes
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
