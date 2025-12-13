import React, { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { z } from 'zod';
import type { Address } from '@/hooks/useAddresses';
import { useCountriesAndStates } from '@/hooks/useCountriesAndStates';

const addressSchema = z.object({
  addressType: z.string().min(1, 'Address type is required'),
  addressLine1: z.string().min(1, 'Address line 1 is required').max(200, 'Address must be less than 200 characters'),
  addressLine2: z.string().max(200, 'Address must be less than 200 characters').optional(),
  city: z.string().min(2, 'City is required').max(100, 'City must be less than 100 characters'),
  countryRegionCode: z.string().min(1, 'Country is required'),
  stateProvinceId: z.number().int().positive('State/Province is required'),
  postalCode: z.string().min(5, 'Postal code is required'),
  isDefault: z.boolean(),
});

interface AddressFormProps {
  address?: Address;
  onSave: (address: Omit<Address, 'id'>) => void;
  onCancel: () => void;
}

export const AddressForm: React.FC<AddressFormProps> = ({ address, onSave, onCancel }) => {
  const [selectedCountry, setSelectedCountry] = useState(address?.countryRegionCode || 'US');
  const { countries, states, isLoading: isLoadingCountriesStates } = useCountriesAndStates(selectedCountry);
  
  const [formData, setFormData] = useState({
    addressType: address?.addressType || 'Home',
    addressLine1: address?.addressLine1 || '',
    addressLine2: address?.addressLine2 || '',
    city: address?.city || '',
    countryRegionCode: address?.countryRegionCode || 'US',
    stateProvinceId: address?.stateProvinceId || 0,
    postalCode: address?.postalCode || '',
    isDefault: address?.isDefault || false,
  });
  
  // Set default state when states load
  useEffect(() => {
    if (states.length > 0 && formData.stateProvinceId === 0) {
      // Default to first state in list (typically alphabetically first)
      setFormData(prev => ({ ...prev, stateProvinceId: states[0].StateProvinceID }));
    }
  }, [states, formData.stateProvinceId]);
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (field: string, value: string | boolean | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };
  
  const handleCountryChange = (countryCode: string) => {
    setSelectedCountry(countryCode);
    setFormData(prev => ({ 
      ...prev, 
      countryRegionCode: countryCode,
      stateProvinceId: 0 // Reset state when country changes
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
        error.errors.forEach(err => {
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
          Address Type *
        </label>
        <select
          value={formData.addressType}
          onChange={(e) => handleChange('addressType', e.target.value)}
          className="doodle-input w-full"
        >
          <option value="Home">Home</option>
          <option value="Shipping">Shipping</option>
          <option value="Billing">Billing</option>
          <option value="Main Office">Main Office</option>
          <option value="Primary">Primary</option>
          <option value="Archive">Archive</option>
        </select>
        {errors.addressType && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.addressType}</p>}
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          Address Line 1 *
        </label>
        <input
          type="text"
          value={formData.addressLine1}
          onChange={(e) => handleChange('addressLine1', e.target.value)}
          className="doodle-input w-full"
          placeholder="123 Adventure Lane"
        />
        {errors.addressLine1 && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.addressLine1}</p>}
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          Address Line 2
        </label>
        <input
          type="text"
          value={formData.addressLine2}
          onChange={(e) => handleChange('addressLine2', e.target.value)}
          className="doodle-input w-full"
          placeholder="Apt 4B (optional)"
        />
        {errors.addressLine2 && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.addressLine2}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            City *
          </label>
          <input
            type="text"
            value={formData.city}
            onChange={(e) => handleChange('city', e.target.value)}
            className="doodle-input w-full"
            placeholder="Seattle"
          />
          {errors.city && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.city}</p>}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            Country *
          </label>
          <select
            value={formData.countryRegionCode}
            onChange={(e) => handleCountryChange(e.target.value)}
            className="doodle-input w-full"
            disabled={isLoadingCountriesStates}
          >
            <option value="">Select Country</option>
            {countries.map((country) => (
              <option key={country.CountryRegionCode} value={country.CountryRegionCode}>
                {country.Name}
              </option>
            ))}
          </select>
          {errors.countryRegionCode && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.countryRegionCode}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            State/Province *
          </label>
          <select
            value={formData.stateProvinceId}
            onChange={(e) => handleChange('stateProvinceId', parseInt(e.target.value))}
            className="doodle-input w-full"
            disabled={isLoadingCountriesStates || states.length === 0}
          >
            <option value="0">Select State/Province</option>
            {states.map((state) => (
              <option key={state.StateProvinceID} value={state.StateProvinceID}>
                {state.Name} ({state.StateProvinceCode})
              </option>
            ))}
          </select>
          {errors.stateProvinceId && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.stateProvinceId}</p>}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            Postal Code *
          </label>
          <input
            type="text"
            value={formData.postalCode}
            onChange={(e) => handleChange('postalCode', e.target.value)}
            className="doodle-input w-full"
            placeholder="98101"
          />
          {errors.postalCode && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.postalCode}</p>}
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={formData.isDefault}
          onChange={(e) => handleChange('isDefault', e.target.checked)}
          className="w-4 h-4"
        />
        <span className="font-doodle text-sm text-doodle-text">Set as default address</span>
      </label>

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          className="doodle-button doodle-button-primary flex-1 flex items-center justify-center gap-2"
        >
          <Save className="w-4 h-4" />
          {address ? 'Update Address' : 'Save Address'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="doodle-button flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          Cancel
        </button>
      </div>
    </form>
  );
};
