import { SpecialOfferProduct } from '@/types/specialOfferProduct';

// Initial mock data linking some promotions to products
export const mockSpecialOfferProducts: SpecialOfferProduct[] = [
  // Mountain-100 Clearance Sale (ID: 7) - linked to Mountain bikes
  { SpecialOfferID: 7, ProductID: 751 }, // Mountain-100
  { SpecialOfferID: 7, ProductID: 752 }, // Mountain-200
  
  // Sport Helmet Discount (ID: 8) - linked to helmets
  { SpecialOfferID: 8, ProductID: 880 }, // Sport-100 Helmet
  { SpecialOfferID: 8, ProductID: 881 }, // Sport-200 Helmet
  
  // Road-650 Overstock (ID: 9) - linked to road bikes
  { SpecialOfferID: 9, ProductID: 749 }, // Road-150
  { SpecialOfferID: 9, ProductID: 750 }, // Road-250
  
  // Touring-1000 Promotion (ID: 11) - linked to touring bikes
  { SpecialOfferID: 11, ProductID: 753 }, // Touring-1000
  { SpecialOfferID: 11, ProductID: 754 }, // Touring-2000
  
  // Summer Sale 2025 (ID: 12) - various products
  { SpecialOfferID: 12, ProductID: 850 }, // Short-Sleeve Classic Jersey
  { SpecialOfferID: 12, ProductID: 851 }, // Long-Sleeve Logo Jersey
  { SpecialOfferID: 12, ProductID: 812 }, // Platform Pedal
  
  // Black Friday 2024 (ID: 14) - wide selection
  { SpecialOfferID: 14, ProductID: 751 }, // Mountain-100
  { SpecialOfferID: 14, ProductID: 749 }, // Road-150
  { SpecialOfferID: 14, ProductID: 753 }, // Touring-1000
  { SpecialOfferID: 14, ProductID: 804 }, // Road-750 Wheels
  { SpecialOfferID: 14, ProductID: 880 }, // Sport-100 Helmet
  
  // New Year Special 2025 (ID: 15)
  { SpecialOfferID: 15, ProductID: 860 }, // Pro Team Jersey
  { SpecialOfferID: 15, ProductID: 809 }, // Touring Wheels
];
