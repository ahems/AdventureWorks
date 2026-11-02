import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, mock } from "node:test";
import { runInNewContext } from "node:vm";
import React from "react";
import ts from "typescript";

function loadSource(relativePath, imports) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: (name) => {
      if (Object.hasOwn(imports, name)) return imports[name];
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return module.exports;
}

const productTypes = loadSource("../src/types/product.ts", {});
const grouping = loadSource("../src/utils/productGrouping.ts", {});

function renderCard({ color = null, size = null, ...overrides } = {}) {
  const product = {
    ProductID: 1,
    ProductModelID: 1,
    Name: "Sale product",
    Color: color,
    Size: size,
    ListPrice: 100,
    DiscountPct: 0.2,
    inStock: true,
    ...overrides,
  };
  const [productGroup] = grouping.groupProductsByModel([product]);
  const addToCart = mock.fn();
  const toast = mock.fn();
  const { default: Card } = loadSource(
    "../src/components/SaleProductModelCard.tsx",
    {
      react: {
        ...React,
        useState: (initial) => [initial, () => {}],
        useMemo: (compute) => compute(),
      },
      "react-router-dom": { Link: "a" },
      "react-i18next": { useTranslation: () => ({ t: (key) => key }) },
      "lucide-react": { ShoppingCart: "svg", Clock: "svg", Bell: "svg" },
      "@/types/product": productTypes,
      "@/utils/productGrouping": grouping,
      "@/components/OptimizedImage": { OptimizedImage: "img" },
      "@/context/CartContext": { useCart: () => ({ addToCart }) },
      "@/hooks/use-toast": { toast },
      "@/context/CurrencyContext": {
        useCurrency: () => ({ formatPrice: String }),
      },
      "@/context/UnitMeasureContext": {
        useUnitMeasure: () => ({ formatSize: String }),
      },
      "@/context/ProductNamesContext": {
        useProductNames: () => ({ getLocalizedName: () => undefined }),
      },
      "@/components/NotifyWhenAvailable": { default: "notify" },
      "@/components/TwemojiText": { TwemojiText: "span" },
      "@/components/ui/select": Object.fromEntries(
        ["Select", "SelectContent", "SelectItem", "SelectTrigger", "SelectValue"]
          .map((name) => [name, name]),
      ),
    },
  );
  return { tree: Card({ productGroup }), product, addToCart, toast };
}

function findAddButton(node) {
  if (!React.isValidElement(node)) return undefined;
  if (
    node.type === "button" &&
    React.Children.toArray(node.props.children).some(
      (child) =>
        React.isValidElement(child) &&
        child.props.children === "saleProductCard.addToCart",
    )
  ) {
    return node;
  }
  for (const child of React.Children.toArray(node.props.children)) {
    const button = findAddButton(child);
    if (button) return button;
  }
}

for (const [name, options] of [
  ["no variant options", {}],
  ["size only", { size: "M" }],
  ["color only", { color: "Red" }],
  ["size and color", { size: "M", color: "Red" }],
]) {
  test(`Add to Cart works with ${name}`, () => {
    const { tree, product, addToCart, toast } = renderCard(options);
    const button = findAddButton(tree);
    assert.ok(button, "An available product must have an Add to Cart button");
    const event = { preventDefault: mock.fn(), stopPropagation: mock.fn() };
    button.props.onClick(event);

    assert.equal(event.preventDefault.mock.callCount(), 1);
    assert.equal(event.stopPropagation.mock.callCount(), 1);
    assert.equal(addToCart.mock.callCount(), 1);
    assert.deepEqual(Array.from(addToCart.mock.calls[0].arguments), [
      product,
      1,
      options.size,
      options.color,
    ]);
    assert.equal(toast.mock.callCount(), 0, "CartContext owns mutation feedback");
  });
}

for (const [name, options] of [
  ["out of stock", { inStock: false }],
  ["unavailable size", {
    size: "M",
    unavailableVariants: [{ size: "M" }],
  }],
  ["unavailable color", {
    color: "Red",
    unavailableVariants: [{ color: "Red" }],
  }],
  ["unavailable size/color", {
    size: "M",
    color: "Red",
    unavailableVariants: [{ size: "M", color: "Red" }],
  }],
]) {
  test(`Does not offer Add to Cart for ${name}`, () => {
    const { tree, addToCart } = renderCard(options);
    assert.equal(findAddButton(tree), undefined);
    assert.equal(addToCart.mock.callCount(), 0);
  });
}
