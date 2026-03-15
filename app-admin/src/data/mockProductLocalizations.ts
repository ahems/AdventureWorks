import { ProductDescription, ProductModel, ProductModelProductDescriptionCulture } from "@/types/productLocalization";

export const productModels: ProductModel[] = [
  { ProductModelID: 1, Name: "HL Road Frame", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 2, Name: "Sport-100 Helmet", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 3, Name: "Mountain-100", ModifiedDate: "2024-01-16T11:00:00Z" },
  { ProductModelID: 4, Name: "Road-150", ModifiedDate: "2024-01-17T12:00:00Z" },
  { ProductModelID: 5, Name: "Touring-1000", ModifiedDate: "2024-01-18T13:00:00Z" },
  { ProductModelID: 6, Name: "ML Mountain Frame", ModifiedDate: "2024-01-19T14:00:00Z" },
  { ProductModelID: 7, Name: "LL Road Frame", ModifiedDate: "2024-01-20T15:00:00Z" },
  { ProductModelID: 8, Name: "Classic Vest", ModifiedDate: "2024-01-21T16:00:00Z" },
];

export const productDescriptions: ProductDescription[] = [
  {
    ProductDescriptionID: 1,
    Description: "Lightweight, high-performance frame for serious road cyclists.",
    rowguid: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 2,
    Description: "Marco ligero de alto rendimiento para ciclistas de carretera serios.",
    rowguid: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 3,
    Description: "Cadre léger et haute performance pour cyclistes de route sérieux.",
    rowguid: "c3d4e5f6-a7b8-9012-cdef-123456789012",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 4,
    Description: "Universal fit helmet with advanced impact protection.",
    rowguid: "d4e5f6a7-b8c9-0123-def1-234567890123",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 5,
    Description: "Casco de ajuste universal con protección avanzada contra impactos.",
    rowguid: "e5f6a7b8-c9d0-1234-ef12-345678901234",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 6,
    Description: "Casque à ajustement universel avec protection avancée contre les chocs.",
    rowguid: "f6a7b8c9-d0e1-2345-f123-456789012345",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
  {
    ProductDescriptionID: 7,
    Description: "Top-of-the-line mountain bike for extreme terrain.",
    rowguid: "a7b8c9d0-e1f2-3456-0123-567890123456",
    ModifiedDate: "2024-01-16T11:00:00Z",
  },
  {
    ProductDescriptionID: 8,
    Description: "Bicicleta de montaña de primera línea para terrenos extremos.",
    rowguid: "b8c9d0e1-f2a3-4567-1234-678901234567",
    ModifiedDate: "2024-01-16T11:00:00Z",
  },
  {
    ProductDescriptionID: 9,
    Description: "VTT haut de gamme pour terrains extrêmes.",
    rowguid: "c9d0e1f2-a3b4-5678-2345-789012345678",
    ModifiedDate: "2024-01-16T11:00:00Z",
  },
  {
    ProductDescriptionID: 10,
    Description: "Leichter Hochleistungsrahmen für ernsthafte Rennradfahrer.",
    rowguid: "d0e1f2a3-b4c5-6789-3456-890123456789",
    ModifiedDate: "2024-01-15T10:00:00Z",
  },
];

export const productModelDescriptionCultures: ProductModelProductDescriptionCulture[] = [
  // HL Road Frame localizations
  { ProductModelID: 1, ProductDescriptionID: 1, CultureID: "en", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 1, ProductDescriptionID: 2, CultureID: "es", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 1, ProductDescriptionID: 3, CultureID: "fr", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 1, ProductDescriptionID: 10, CultureID: "de", ModifiedDate: "2024-01-15T10:00:00Z" },
  // Sport-100 Helmet localizations
  { ProductModelID: 2, ProductDescriptionID: 4, CultureID: "en", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 2, ProductDescriptionID: 5, CultureID: "es", ModifiedDate: "2024-01-15T10:00:00Z" },
  { ProductModelID: 2, ProductDescriptionID: 6, CultureID: "fr", ModifiedDate: "2024-01-15T10:00:00Z" },
  // Mountain-100 localizations
  { ProductModelID: 3, ProductDescriptionID: 7, CultureID: "en", ModifiedDate: "2024-01-16T11:00:00Z" },
  { ProductModelID: 3, ProductDescriptionID: 8, CultureID: "es", ModifiedDate: "2024-01-16T11:00:00Z" },
  { ProductModelID: 3, ProductDescriptionID: 9, CultureID: "fr", ModifiedDate: "2024-01-16T11:00:00Z" },
];
