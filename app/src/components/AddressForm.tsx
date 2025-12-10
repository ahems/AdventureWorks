import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { z } from 'zod';
import type { Address } from '@/hooks/useAddresses';
import { formatPhoneNumber, parsePhoneNumber } from '@/lib/phoneFormatter';

const addressSchema = z.object({
  label: z.string().min(1, 'Label is required').max(50, 'Label must be less than 50 characters'),
  firstName: z.string().min(1, 'First name is required').max(50, 'First name must be less than 50 characters'),
  lastName: z.string().min(1, 'Last name is required').max(50, 'Last name must be less than 50 characters'),
  phone: z.string().min(10, 'Valid phone number is required'),
  address: z.string().min(5, 'Address is required').max(200, 'Address must be less than 200 characters'),
  city: z.string().min(2, 'City is required').max(100, 'City must be less than 100 characters'),
  state: z.string().min(2, 'State is required').max(50, 'State must be less than 50 characters'),
  zipCode: z.string().min(5, 'ZIP code is required'),
  country: z.string().min(2, 'Country is required'),
  isDefault: z.boolean(),
});

interface AddressFormProps {
  address?: Address;
  onSave: (address: Omit<Address, 'id'>) => void;
  onCancel: () => void;
}

export const AddressForm: React.FC<AddressFormProps> = ({ address, onSave, onCancel }) => {
  // Parse phone number to extract country code
  let initialCountryCode = '+1';
  let initialPhoneNumber = '';
  
  if (address?.phone) {
    const match = address.phone.match(/^(\+\d+)\s*(.*)$/);
    if (match) {
      initialCountryCode = match[1];
      initialPhoneNumber = formatPhoneNumber(match[2], match[1]);
    } else {
      initialPhoneNumber = formatPhoneNumber(address.phone, '+1');
    }
  }
  
  const [formData, setFormData] = useState({
    label: address?.label || '',
    firstName: address?.firstName || '',
    lastName: address?.lastName || '',
    countryCode: initialCountryCode,
    phone: initialPhoneNumber,
    address: address?.address || '',
    city: address?.city || '',
    state: address?.state || '',
    zipCode: address?.zipCode || '',
    country: address?.country || 'United States',
    isDefault: address?.isDefault || false,
  });
  
  const [errors, setErrors] = useState<Record<string, string>>({});

  const handleChange = (field: string, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Combine country code with phone number
      const cleanPhone = parsePhoneNumber(formData.phone);
      const fullPhone = cleanPhone ? `${formData.countryCode} ${cleanPhone}` : '';
      
      const dataToValidate = { ...formData, phone: fullPhone };
      addressSchema.parse(dataToValidate);
      setErrors({});
      
      // Save with combined phone number
      const { countryCode, ...dataToSave } = dataToValidate;
      onSave(dataToSave);
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
          Address Label *
        </label>
        <input
          type="text"
          value={formData.label}
          onChange={(e) => handleChange('label', e.target.value)}
          className="doodle-input w-full"
          placeholder="Home, Office, etc."
        />
        {errors.label && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.label}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            First Name *
          </label>
          <input
            type="text"
            value={formData.firstName}
            onChange={(e) => handleChange('firstName', e.target.value)}
            className="doodle-input w-full"
            placeholder="John"
          />
          {errors.firstName && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.firstName}</p>}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            Last Name *
          </label>
          <input
            type="text"
            value={formData.lastName}
            onChange={(e) => handleChange('lastName', e.target.value)}
            className="doodle-input w-full"
            placeholder="Doe"
          />
          {errors.lastName && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.lastName}</p>}
        </div>
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          Phone *
        </label>
        <div className="flex gap-2">
          <select
            value={formData.countryCode}
            onChange={(e) => handleChange('countryCode', e.target.value)}
            className="doodle-input w-24 flex-shrink-0"
          >
            <option value="+1">🇺🇸 +1</option>
            <option value="+44">🇬🇧 +44</option>
            <option value="+61">🇦🇺 +61</option>
            <option value="+81">🇯🇵 +81</option>
            <option value="+86">🇨🇳 +86</option>
            <option value="+49">🇩🇪 +49</option>
            <option value="+33">🇫🇷 +33</option>
            <option value="+39">🇮🇹 +39</option>
            <option value="+34">🇪🇸 +34</option>
            <option value="+52">🇲🇽 +52</option>
            <option value="+55">🇧🇷 +55</option>
            <option value="+91">🇮🇳 +91</option>
          </select>
          <input
            type="tel"
            value={formData.phone}
            onChange={(e) => {
              const formatted = formatPhoneNumber(e.target.value, formData.countryCode);
              handleChange('phone', formatted);
            }}
            className="doodle-input flex-1"
            placeholder="(555) 123-4567"
          />
        </div>
        {errors.phone && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.phone}</p>}
      </div>

      <div>
        <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
          Street Address *
        </label>
        <input
          type="text"
          value={formData.address}
          onChange={(e) => handleChange('address', e.target.value)}
          className="doodle-input w-full"
          placeholder="123 Adventure Lane"
        />
        {errors.address && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.address}</p>}
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
            State *
          </label>
          <input
            type="text"
            value={formData.state}
            onChange={(e) => handleChange('state', e.target.value)}
            className="doodle-input w-full"
            placeholder="WA"
          />
          {errors.state && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.state}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            ZIP Code *
          </label>
          <input
            type="text"
            value={formData.zipCode}
            onChange={(e) => handleChange('zipCode', e.target.value)}
            className="doodle-input w-full"
            placeholder="98101"
          />
          {errors.zipCode && <p className="font-doodle text-xs text-doodle-accent mt-1">{errors.zipCode}</p>}
        </div>
        <div>
          <label className="font-doodle text-sm font-bold text-doodle-text block mb-1">
            Country *
          </label>
          <select
            value={formData.country}
            onChange={(e) => handleChange('country', e.target.value)}
            className="doodle-input w-full"
          >
            <option>United States</option>
            <option>Canada</option>
            <option>United Kingdom</option>
            <option>Australia</option>
          </select>
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
