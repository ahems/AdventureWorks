export interface ProductDescription {
  ProductDescriptionID: number;
  Description: string;
  rowguid: string;
  ModifiedDate: string;
}

export interface ProductModel {
  ProductModelID: number;
  Name: string;
  ModifiedDate: string;
}

export interface ProductModelProductDescriptionCulture {
  ProductModelID: number;
  ProductDescriptionID: number;
  CultureID: string;
  ModifiedDate: string;
}
