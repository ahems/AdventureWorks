import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Import all translation files - Common
import enCommon from "./locales/en/common.json";
import enGbCommon from "./locales/en-gb/common.json";
import enCaCommon from "./locales/en-ca/common.json";
import enAuCommon from "./locales/en-au/common.json";
import enNzCommon from "./locales/en-nz/common.json";
import enIeCommon from "./locales/en-ie/common.json";
import esCommon from "./locales/es/common.json";
import frCommon from "./locales/fr/common.json";
import deCommon from "./locales/de/common.json";
import ptCommon from "./locales/pt/common.json";
import itCommon from "./locales/it/common.json";
import nlCommon from "./locales/nl/common.json";
import ruCommon from "./locales/ru/common.json";
import zhCommon from "./locales/zh/common.json";
import zhChtCommon from "./locales/zh-cht/common.json";
import jaCommon from "./locales/ja/common.json";
import koCommon from "./locales/ko/common.json";
import arCommon from "./locales/ar/common.json";
import heCommon from "./locales/he/common.json";
import trCommon from "./locales/tr/common.json";
import viCommon from "./locales/vi/common.json";
import thCommon from "./locales/th/common.json";
import idCommon from "./locales/id/common.json";

// Product namespace
import enProduct from "./locales/en/product.json";
import enGbProduct from "./locales/en-gb/product.json";
import enCaProduct from "./locales/en-ca/product.json";
import enAuProduct from "./locales/en-au/product.json";
import enNzProduct from "./locales/en-nz/product.json";
import enIeProduct from "./locales/en-ie/product.json";
import esProduct from "./locales/es/product.json";
import frProduct from "./locales/fr/product.json";
import deProduct from "./locales/de/product.json";
import ptProduct from "./locales/pt/product.json";
import itProduct from "./locales/it/product.json";
import nlProduct from "./locales/nl/product.json";
import ruProduct from "./locales/ru/product.json";
import zhProduct from "./locales/zh/product.json";
import zhChtProduct from "./locales/zh-cht/product.json";
import jaProduct from "./locales/ja/product.json";
import koProduct from "./locales/ko/product.json";
import arProduct from "./locales/ar/product.json";
import heProduct from "./locales/he/product.json";
import trProduct from "./locales/tr/product.json";
import viProduct from "./locales/vi/product.json";
import thProduct from "./locales/th/product.json";
import idProduct from "./locales/id/product.json";

// Cart namespace
import enCart from "./locales/en/cart.json";
import enGbCart from "./locales/en-gb/cart.json";
import enCaCart from "./locales/en-ca/cart.json";
import enAuCart from "./locales/en-au/cart.json";
import enNzCart from "./locales/en-nz/cart.json";
import enIeCart from "./locales/en-ie/cart.json";
import esCart from "./locales/es/cart.json";
import frCart from "./locales/fr/cart.json";
import deCart from "./locales/de/cart.json";
import ptCart from "./locales/pt/cart.json";
import itCart from "./locales/it/cart.json";
import nlCart from "./locales/nl/cart.json";
import ruCart from "./locales/ru/cart.json";
import zhCart from "./locales/zh/cart.json";
import zhChtCart from "./locales/zh-cht/cart.json";
import jaCart from "./locales/ja/cart.json";
import koCart from "./locales/ko/cart.json";
import arCart from "./locales/ar/cart.json";
import heCart from "./locales/he/cart.json";
import trCart from "./locales/tr/cart.json";
import viCart from "./locales/vi/cart.json";
import thCart from "./locales/th/cart.json";
import idCart from "./locales/id/cart.json";

// Account namespace
import enAccount from "./locales/en/account.json";
import enGbAccount from "./locales/en-gb/account.json";
import enCaAccount from "./locales/en-ca/account.json";
import enAuAccount from "./locales/en-au/account.json";
import enNzAccount from "./locales/en-nz/account.json";
import enIeAccount from "./locales/en-ie/account.json";
import esAccount from "./locales/es/account.json";
import frAccount from "./locales/fr/account.json";
import deAccount from "./locales/de/account.json";
import ptAccount from "./locales/pt/account.json";
import itAccount from "./locales/it/account.json";
import nlAccount from "./locales/nl/account.json";
import ruAccount from "./locales/ru/account.json";
import zhAccount from "./locales/zh/account.json";
import zhChtAccount from "./locales/zh-cht/account.json";
import jaAccount from "./locales/ja/account.json";
import koAccount from "./locales/ko/account.json";
import arAccount from "./locales/ar/account.json";
import heAccount from "./locales/he/account.json";
import trAccount from "./locales/tr/account.json";
import viAccount from "./locales/vi/account.json";
import thAccount from "./locales/th/account.json";
import idAccount from "./locales/id/account.json";

// Footer namespace
import enFooter from "./locales/en/footer.json";
import enGbFooter from "./locales/en-gb/footer.json";
import enCaFooter from "./locales/en-ca/footer.json";
import enAuFooter from "./locales/en-au/footer.json";
import enNzFooter from "./locales/en-nz/footer.json";
import enIeFooter from "./locales/en-ie/footer.json";
import esFooter from "./locales/es/footer.json";
import frFooter from "./locales/fr/footer.json";
import deFooter from "./locales/de/footer.json";
import ptFooter from "./locales/pt/footer.json";
import itFooter from "./locales/it/footer.json";
import nlFooter from "./locales/nl/footer.json";
import ruFooter from "./locales/ru/footer.json";
import zhFooter from "./locales/zh/footer.json";
import zhChtFooter from "./locales/zh-cht/footer.json";
import jaFooter from "./locales/ja/footer.json";
import koFooter from "./locales/ko/footer.json";
import arFooter from "./locales/ar/footer.json";
import heFooter from "./locales/he/footer.json";
import trFooter from "./locales/tr/footer.json";
import viFooter from "./locales/vi/footer.json";
import thFooter from "./locales/th/footer.json";
import idFooter from "./locales/id/footer.json";

// Chat namespace
import enChat from "./locales/en/chat.json";
import enGbChat from "./locales/en-gb/chat.json";
import enCaChat from "./locales/en-ca/chat.json";
import enAuChat from "./locales/en-au/chat.json";
import enNzChat from "./locales/en-nz/chat.json";
import enIeChat from "./locales/en-ie/chat.json";
import esChat from "./locales/es/chat.json";
import frChat from "./locales/fr/chat.json";
import deChat from "./locales/de/chat.json";
import ptChat from "./locales/pt/chat.json";
import itChat from "./locales/it/chat.json";
import nlChat from "./locales/nl/chat.json";
import ruChat from "./locales/ru/chat.json";
import zhChat from "./locales/zh/chat.json";
import zhChtChat from "./locales/zh-cht/chat.json";
import jaChat from "./locales/ja/chat.json";
import koChat from "./locales/ko/chat.json";
import arChat from "./locales/ar/chat.json";
import heChat from "./locales/he/chat.json";
import trChat from "./locales/tr/chat.json";
import viChat from "./locales/vi/chat.json";
import thChat from "./locales/th/chat.json";
import idChat from "./locales/id/chat.json";

const resources = {
  en: {
    common: enCommon,
    product: enProduct,
    cart: enCart,
    account: enAccount,
    footer: enFooter,
    chat: enChat,
  },
  "en-gb": {
    common: enGbCommon,
    product: enGbProduct,
    cart: enGbCart,
    account: enGbAccount,
    footer: enGbFooter,
    chat: enGbChat,
  },
  "en-ca": {
    common: enCaCommon,
    product: enCaProduct,
    cart: enCaCart,
    account: enCaAccount,
    footer: enCaFooter,
    chat: enCaChat,
  },
  "en-au": {
    common: enAuCommon,
    product: enAuProduct,
    cart: enAuCart,
    account: enAuAccount,
    footer: enAuFooter,
    chat: enAuChat,
  },
  "en-nz": {
    common: enNzCommon,
    product: enNzProduct,
    cart: enNzCart,
    account: enNzAccount,
    footer: enNzFooter,
    chat: enNzChat,
  },
  "en-ie": {
    common: enIeCommon,
    product: enIeProduct,
    cart: enIeCart,
    account: enIeAccount,
    footer: enIeFooter,
    chat: enIeChat,
  },
  es: {
    common: esCommon,
    product: esProduct,
    cart: esCart,
    account: esAccount,
    footer: esFooter,
    chat: esChat,
  },
  fr: {
    common: frCommon,
    product: frProduct,
    cart: frCart,
    account: frAccount,
    footer: frFooter,
    chat: frChat,
  },
  de: {
    common: deCommon,
    product: deProduct,
    cart: deCart,
    account: deAccount,
    footer: deFooter,
    chat: deChat,
  },
  pt: {
    common: ptCommon,
    product: ptProduct,
    cart: ptCart,
    account: ptAccount,
    footer: ptFooter,
    chat: ptChat,
  },
  it: {
    common: itCommon,
    product: itProduct,
    cart: itCart,
    account: itAccount,
    footer: itFooter,
    chat: itChat,
  },
  nl: {
    common: nlCommon,
    product: nlProduct,
    cart: nlCart,
    account: nlAccount,
    footer: nlFooter,
    chat: nlChat,
  },
  ru: {
    common: ruCommon,
    product: ruProduct,
    cart: ruCart,
    account: ruAccount,
    footer: ruFooter,
    chat: ruChat,
  },
  zh: {
    common: zhCommon,
    product: zhProduct,
    cart: zhCart,
    account: zhAccount,
    footer: zhFooter,
    chat: zhChat,
  },
  "zh-cht": {
    common: zhChtCommon,
    product: zhChtProduct,
    cart: zhChtCart,
    account: zhChtAccount,
    footer: zhChtFooter,
    chat: zhChtChat,
  },
  ja: {
    common: jaCommon,
    product: jaProduct,
    cart: jaCart,
    account: jaAccount,
    footer: jaFooter,
    chat: jaChat,
  },
  ko: {
    common: koCommon,
    product: koProduct,
    cart: koCart,
    account: koAccount,
    footer: koFooter,
    chat: koChat,
  },
  ar: {
    common: arCommon,
    product: arProduct,
    cart: arCart,
    account: arAccount,
    footer: arFooter,
    chat: arChat,
  },
  he: {
    common: heCommon,
    product: heProduct,
    cart: heCart,
    account: heAccount,
    footer: heFooter,
    chat: heChat,
  },
  tr: {
    common: trCommon,
    product: trProduct,
    cart: trCart,
    account: trAccount,
    footer: trFooter,
    chat: trChat,
  },
  vi: {
    common: viCommon,
    product: viProduct,
    cart: viCart,
    account: viAccount,
    footer: viFooter,
    chat: viChat,
  },
  th: {
    common: thCommon,
    product: thProduct,
    cart: thCart,
    account: thAccount,
    footer: thFooter,
    chat: thChat,
  },
  id: {
    common: idCommon,
    product: idProduct,
    cart: idCart,
    account: idAccount,
    footer: idFooter,
    chat: idChat,
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: "en", // default language
  fallbackLng: "en",
  ns: ["common", "product", "cart", "account", "footer", "chat"], // namespaces
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
