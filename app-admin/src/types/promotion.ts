export interface SpecialOffer {
  SpecialOfferID: number;
  Description: string;
  DiscountPct: number;
  Type: string;
  Category: string;
  StartDate: string;
  EndDate: string;
  MinQty: number;
  MaxQty: number | null;
  rowguid?: string;
  ModifiedDate?: string;
}

export type SpecialOfferFormData = Omit<SpecialOffer, 'SpecialOfferID' | 'rowguid' | 'ModifiedDate'>;

export const OFFER_TYPES = [
  'No Discount',
  'Volume Discount',
  'Seasonal Discount',
  'Customer Discount',
  'Promotional Discount',
  'Clearance',
] as const;

export const OFFER_CATEGORIES = [
  'Customer',
  'Reseller',
  'No Discount',
] as const;

export const getOfferStatus = (offer: SpecialOffer): 'active' | 'upcoming' | 'expired' => {
  const now = new Date();
  const startDate = new Date(offer.StartDate);
  const endDate = new Date(offer.EndDate);
  
  if (now < startDate) return 'upcoming';
  if (now > endDate) return 'expired';
  return 'active';
};
