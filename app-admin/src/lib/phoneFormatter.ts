/**
 * Format phone number based on country code
 */
export function formatPhoneNumber(
  phoneNumber: string,
  countryCode: string = "+1"
): string {
  // Remove all non-digit characters
  const cleaned = phoneNumber.replace(/\D/g, "");

  // Format based on country code
  if (countryCode === "+1") {
    // US/Canada format: (555) 123-4567
    if (cleaned.length === 0) return "";
    if (cleaned.length <= 3) return cleaned;
    if (cleaned.length <= 6)
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3)}`;
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(
      6,
      10
    )}`;
  }

  // Default format for other countries: space-separated groups
  if (cleaned.length <= 3) return cleaned;
  if (cleaned.length <= 6) return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
  if (cleaned.length <= 9)
    return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(
    6,
    10
  )}`;
}

/**
 * Parse phone number to remove all formatting
 */
export function parsePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, "");
}
