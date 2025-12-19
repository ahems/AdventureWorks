import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Import all translation files - Common
import enCommon from "./locales/en/common.json";
import esCommon from "./locales/es/common.json";
import frCommon from "./locales/fr/common.json";
import arCommon from "./locales/ar/common.json";
import heCommon from "./locales/he/common.json";
import thCommon from "./locales/th/common.json";
import zhCommon from "./locales/zh-cht/common.json";

// Product namespace
import enProduct from "./locales/en/product.json";
import esProduct from "./locales/es/product.json";
import frProduct from "./locales/fr/product.json";
import arProduct from "./locales/ar/product.json";
import heProduct from "./locales/he/product.json";
import thProduct from "./locales/th/product.json";
import zhProduct from "./locales/zh-cht/product.json";

// Cart namespace
import enCart from "./locales/en/cart.json";
import esCart from "./locales/es/cart.json";
import frCart from "./locales/fr/cart.json";
import arCart from "./locales/ar/cart.json";
import heCart from "./locales/he/cart.json";
import thCart from "./locales/th/cart.json";
import zhCart from "./locales/zh-cht/cart.json";

// Account namespace
import enAccount from "./locales/en/account.json";
import esAccount from "./locales/es/account.json";
import frAccount from "./locales/fr/account.json";
import arAccount from "./locales/ar/account.json";
import heAccount from "./locales/he/account.json";
import thAccount from "./locales/th/account.json";
import zhAccount from "./locales/zh-cht/account.json";

// Footer namespace
import enFooter from "./locales/en/footer.json";
import esFooter from "./locales/es/footer.json";
import frFooter from "./locales/fr/footer.json";
import arFooter from "./locales/ar/footer.json";
import heFooter from "./locales/he/footer.json";
import thFooter from "./locales/th/footer.json";
import zhFooter from "./locales/zh-cht/footer.json";

const resources = {
  en: {
    common: enCommon,
    product: enProduct,
    cart: enCart,
    account: enAccount,
    footer: enFooter,
  },
  es: {
    common: esCommon,
    product: esProduct,
    cart: esCart,
    account: esAccount,
    footer: esFooter,
  },
  fr: {
    common: frCommon,
    product: frProduct,
    cart: frCart,
    account: frAccount,
    footer: frFooter,
  },
  ar: {
    common: arCommon,
    product: arProduct,
    cart: arCart,
    account: arAccount,
    footer: arFooter,
  },
  he: {
    common: heCommon,
    product: heProduct,
    cart: heCart,
    account: heAccount,
    footer: heFooter,
  },
  th: {
    common: thCommon,
    product: thProduct,
    cart: thCart,
    account: thAccount,
    footer: thFooter,
  },
  "zh-cht": {
    common: zhCommon,
    product: zhProduct,
    cart: zhCart,
    account: zhAccount,
    footer: zhFooter,
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: "en", // default language
  fallbackLng: "en",
  ns: ["common", "product", "cart", "account", "footer"], // namespaces
  defaultNS: "common",
  interpolation: {
    escapeValue: false, // React already escapes
  },
  react: {
    useSuspense: false, // Disable suspense to avoid hydration issues
    bindI18n: "languageChanged", // Bind to language change events
    bindI18nStore: "", // Don't bind to store events
  },
});

export default i18n;
