import { gql } from "graphql-request";

// Query to get product reviews by product ID
export const GET_PRODUCT_REVIEWS = gql`
  query GetProductReviews($productId: Int!) {
    productReviews(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductReviewID
        ProductID
        ReviewerName
        ReviewDate
        EmailAddress
        Rating
        Comments
        HelpfulVotes
        UserID
      }
    }
  }
`;

// Query to get all product reviews
export const GET_ALL_REVIEWS = gql`
  query GetAllReviews {
    productReviews(first: 1000) {
      items {
        ProductReviewID
        ProductID
        ReviewerName
        ReviewDate
        EmailAddress
        Rating
        Comments
        HelpfulVotes
        UserID
      }
    }
  }
`;

// Query to get customer special offers (Category = "Customer")
export const GET_CUSTOMER_SPECIAL_OFFERS = gql`
  query GetCustomerSpecialOffers {
    specialOffers(filter: { Category: { eq: "Customer" } }) {
      items {
        SpecialOfferID
        Description
        DiscountPct
        Type
        Category
      }
    }
  }
`;

// Query to get products with special offers
export const GET_SPECIAL_OFFER_PRODUCTS = gql`
  query GetSpecialOfferProducts($offerIds: [Int!]!) {
    specialOfferProducts(filter: { SpecialOfferID: { in: $offerIds } }) {
      items {
        SpecialOfferID
        ProductID
      }
    }
  }
`;

// Query to get all product categories for a specific culture
// Note: Data API Builder uses plural entity names and returns items directly
export const GET_CATEGORIES = gql`
  query GetCategories($cultureId: String!) {
    productCategories(filter: { CultureID: { eq: $cultureId } }) {
      items {
        ProductCategoryID
        CultureID
        Name
      }
    }
  }
`;

// Query to get all product subcategories
export const GET_SUBCATEGORIES = gql`
  query GetSubcategories {
    productSubcategories {
      items {
        ProductSubcategoryID
        ProductCategoryID
        Name
      }
    }
  }
`;

// Query to get subcategories by category ID
export const GET_SUBCATEGORIES_BY_CATEGORY = gql`
  query GetSubcategoriesByCategory($categoryId: Int!) {
    productSubcategories(filter: { ProductCategoryID: { eq: $categoryId } }) {
      items {
        ProductSubcategoryID
        ProductCategoryID
        Name
      }
    }
  }
`;

// Query to get all products (only finished goods for retail)
export const GET_PRODUCTS = gql`
  query GetProducts {
    products(first: 1000, filter: { FinishedGoodsFlag: { eq: true } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        SizeUnitMeasureCode
        Weight
        WeightUnitMeasureCode
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// Query to get products by multiple IDs (for cart)
export const GET_PRODUCTS_BY_IDS = gql`
  query GetProductsByIds($ids: [Int!]!) {
    products(filter: { ProductID: { in: $ids } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        SizeUnitMeasureCode
        Weight
        WeightUnitMeasureCode
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// Query to get a product by ID
// Note: Only loads thumbnails initially. Use GET_LARGE_PHOTO separately for fullscreen/zoom
export const GET_PRODUCT_BY_ID = gql`
  query GetProductById($id: Int!) {
    products(filter: { ProductID: { eq: $id } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        SizeUnitMeasureCode
        Weight
        WeightUnitMeasureCode
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
        productProductPhotos {
          items {
            ProductPhotoID
            Primary
            productPhoto {
              ProductPhotoID
              ThumbNailPhoto
              ThumbnailPhotoFileName
            }
          }
        }
      }
    }
  }
`;

// Query to get product description by ProductModelID and Culture
export const GET_PRODUCT_DESCRIPTION = gql`
  query GetProductDescription($productModelId: Int!, $cultureId: String!) {
    productModelProductDescriptionCultures(
      filter: {
        ProductModelID: { eq: $productModelId }
        CultureID: { eq: $cultureId }
      }
    ) {
      items {
        ProductDescriptionID
        CultureID
      }
    }
  }
`;

// Query to get description text by ProductDescriptionID
export const GET_DESCRIPTION_TEXT = gql`
  query GetDescriptionText($descriptionId: Int!) {
    productDescriptions(
      filter: { ProductDescriptionID: { eq: $descriptionId } }
    ) {
      items {
        Description
      }
    }
  }
`;

// Query to get products by category ID (not directly used, handled in apiService)
export const GET_PRODUCTS_BY_CATEGORY = gql`
  query GetProductsByCategory($categoryId: Int!) {
    products(filter: { ProductSubcategoryID: { neq: null } }) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        Weight
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// Query to get products by multiple subcategory IDs (used for category filtering, only finished goods)
export const GET_PRODUCTS_BY_SUBCATEGORY_IDS = gql`
  query GetProductsBySubcategoryIds($subcategoryIds: [Int!]!) {
    products(
      filter: {
        ProductSubcategoryID: { in: $subcategoryIds }
        FinishedGoodsFlag: { eq: true }
      }
      first: 1000
    ) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        SizeUnitMeasureCode
        Weight
        WeightUnitMeasureCode
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// Query to get photo data by photo ID (thumbnails only)
export const GET_PHOTO_DATA = gql`
  query GetPhotoData($photoId: Int!) {
    productPhotos(filter: { ProductPhotoID: { eq: $photoId } }) {
      items {
        ProductPhotoID
        ThumbNailPhoto
        ThumbnailPhotoFileName
      }
    }
  }
`;

// Query to get a single large photo on-demand (for fullscreen view)
export const GET_LARGE_PHOTO = gql`
  query GetLargePhoto($photoId: Int!) {
    productPhotos(filter: { ProductPhotoID: { eq: $photoId } }) {
      items {
        ProductPhotoID
        LargePhoto
        LargePhotoFileName
      }
    }
  }
`;

// Query to get product photos by product IDs (batch fetch)
export const GET_PRODUCT_PHOTOS_BATCH = gql`
  query GetProductPhotosBatch($productIds: [Int!]!) {
    productProductPhotos(
      filter: { ProductID: { in: $productIds }, Primary: { eq: true } }
    ) {
      items {
        ProductID
        ProductPhotoID
      }
    }
  }
`;

// Query to get photos by photo IDs (batch fetch)
// Note: Only fetches thumbnails to avoid OutOfMemoryException with large photos
export const GET_PHOTOS_BY_IDS = gql`
  query GetPhotosByIds($photoIds: [Int!]!) {
    productPhotos(filter: { ProductPhotoID: { in: $photoIds } }) {
      items {
        ProductPhotoID
        ThumbNailPhoto
        ThumbnailPhotoFileName
      }
    }
  }
`;

// Query to get products by subcategory ID (only finished goods)
export const GET_PRODUCTS_BY_SUBCATEGORY = gql`
  query GetProductsBySubcategory($subcategoryId: Int!) {
    products(
      filter: {
        ProductSubcategoryID: { eq: $subcategoryId }
        FinishedGoodsFlag: { eq: true }
      }
      first: 1000
    ) {
      items {
        ProductID
        Name
        ProductNumber
        Color
        ListPrice
        StandardCost
        Size
        SizeUnitMeasureCode
        Weight
        WeightUnitMeasureCode
        ProductLine
        Class
        Style
        ProductSubcategoryID
        ProductModelID
        SellStartDate
        SellEndDate
        DiscontinuedDate
      }
    }
  }
`;

// Query to get category by ID for a specific culture
export const GET_CATEGORY_BY_ID = gql`
  query GetCategoryById($id: Int!, $cultureId: String!) {
    productCategories(filter: { and: [{ ProductCategoryID: { eq: $id } }, { CultureID: { eq: $cultureId } }] }) {
      items {
        ProductCategoryID
        CultureID
        Name
      }
    }
  }
`;

// Query to get subcategory by ID
export const GET_SUBCATEGORY_BY_ID = gql`
  query GetSubcategoryById($id: Int!) {
    productSubcategories(filter: { ProductSubcategoryID: { eq: $id } }) {
      items {
        ProductSubcategoryID
        ProductCategoryID
        Name
      }
    }
  }
`;

// Query to get inventory for a specific product (all locations)
export const GET_PRODUCT_INVENTORY = gql`
  query GetProductInventory($productId: Int!) {
    productInventories(filter: { ProductID: { eq: $productId } }) {
      items {
        ProductID
        LocationID
        Shelf
        Bin
        Quantity
      }
    }
  }
`;

// Query to get inventory for multiple products
export const GET_PRODUCTS_INVENTORY = gql`
  query GetProductsInventory($productIds: [Int!]!) {
    productInventories(
      filter: { ProductID: { in: $productIds } }
      first: 10000
    ) {
      items {
        ProductID
        LocationID
        Quantity
      }
    }
  }
`;

// Authentication Queries and Mutations

// Query to find user by email
export const GET_USER_BY_EMAIL = gql`
  query GetUserByEmail($email: String!) {
    emailAddresses(filter: { EmailAddress: { eq: $email } }) {
      items {
        BusinessEntityID
        EmailAddress
        EmailAddressID
      }
    }
  }
`;

// Query to get person details
export const GET_PERSON = gql`
  query GetPerson($businessEntityId: Int!) {
    person_by_pk(BusinessEntityID: $businessEntityId) {
      BusinessEntityID
      PersonType
      FirstName
      MiddleName
      LastName
    }
  }
`;

// Query to get password hash for authentication
export const GET_PASSWORD = gql`
  query GetPassword($businessEntityId: Int!) {
    password_by_pk(BusinessEntityID: $businessEntityId) {
      BusinessEntityID
      PasswordHash
      PasswordSalt
    }
  }
`;

// Mutation to create a business entity (required before creating Person)
export const CREATE_BUSINESS_ENTITY = gql`
  mutation CreateBusinessEntity($item: CreateBusinessEntityInput!) {
    createBusinessEntity(item: $item) {
      BusinessEntityID
    }
  }
`;

// Mutation to create a new person
export const CREATE_PERSON = gql`
  mutation CreatePerson($item: CreatePersonInput!) {
    createPerson(item: $item) {
      BusinessEntityID
      PersonType
      FirstName
      MiddleName
      LastName
    }
  }
`;

// Mutation to create email address
export const CREATE_EMAIL_ADDRESS = gql`
  mutation CreateEmailAddress($item: CreateEmailAddressInput!) {
    createEmailAddress(item: $item) {
      BusinessEntityID
      EmailAddress
      EmailAddressID
    }
  }
`;

// Mutation to create password
export const CREATE_PASSWORD = gql`
  mutation CreatePassword($item: CreatePasswordInput!) {
    createPassword(item: $item) {
      BusinessEntityID
      PasswordHash
      PasswordSalt
    }
  }
`;

// Mutation to create customer record
export const CREATE_CUSTOMER = gql`
  mutation CreateCustomer($item: CreateCustomerInput!) {
    createCustomer(item: $item) {
      CustomerID
      PersonID
      AccountNumber
    }
  }
`;

// Mutation to update person
export const UPDATE_PERSON = gql`
  mutation UpdatePerson($businessEntityId: Int!, $item: UpdatePersonInput!) {
    updatePerson(BusinessEntityID: $businessEntityId, item: $item) {
      BusinessEntityID
      FirstName
      LastName
    }
  }
`;

// Mutation to update email address
export const UPDATE_EMAIL_ADDRESS = gql`
  mutation UpdateEmailAddress(
    $businessEntityId: Int!
    $emailAddressId: Int!
    $item: UpdateEmailAddressInput!
  ) {
    updateEmailAddress(
      BusinessEntityID: $businessEntityId
      EmailAddressID: $emailAddressId
      item: $item
    ) {
      BusinessEntityID
      EmailAddress
      EmailAddressID
    }
  }
`;

// Mutation to update password
export const UPDATE_PASSWORD = gql`
  mutation UpdatePassword(
    $businessEntityId: Int!
    $item: UpdatePasswordInput!
  ) {
    updatePassword(BusinessEntityID: $businessEntityId, item: $item) {
      BusinessEntityID
      PasswordHash
      PasswordSalt
    }
  }
`;

// Shopping Cart Queries
export const GET_SHOPPING_CART_ITEMS = gql`
  query GetShoppingCartItems($shoppingCartId: String!) {
    shoppingCartItems(filter: { ShoppingCartID: { eq: $shoppingCartId } }) {
      items {
        ShoppingCartItemID
        ShoppingCartID
        ProductID
        Quantity
        DateCreated
        ModifiedDate
      }
    }
  }
`;

export const CREATE_CART_ITEM = gql`
  mutation CreateCartItem($item: CreateShoppingCartItemInput!) {
    createShoppingCartItem(item: $item) {
      ShoppingCartItemID
      ShoppingCartID
      ProductID
      Quantity
    }
  }
`;

export const UPDATE_CART_ITEM = gql`
  mutation UpdateCartItem(
    $shoppingCartItemId: Int!
    $item: UpdateShoppingCartItemInput!
  ) {
    updateShoppingCartItem(
      ShoppingCartItemID: $shoppingCartItemId
      item: $item
    ) {
      ShoppingCartItemID
      ShoppingCartID
      ProductID
      Quantity
      ModifiedDate
    }
  }
`;

export const DELETE_CART_ITEM = gql`
  mutation DeleteCartItem($shoppingCartItemId: Int!) {
    deleteShoppingCartItem(ShoppingCartItemID: $shoppingCartItemId) {
      ShoppingCartItemID
    }
  }
`;
