import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(
    Boolean,
  ),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "@tanstack/react-query",
      "graphql-request",
      "graphql",
      "recharts",
      "lucide-react",
      "react-hook-form",
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          // graphql-request has internal circular ESM references — isolate it.
          if (/\/(graphql-request|graphql)\//.test(id)) return "vendor-graphql";

          // Each d3 sub-package is isolated individually.
          // d3 packages have internal circular refs that crash when merged with
          // other chunks. Each gets its own file so rollup can sort them internally.
          const d3m = id.match(/\/(d3-[^/]+)\//);
          if (d3m) return `vendor-${d3m[1]}`;

          // recharts gets its own chunk (it imports d3-* which are isolated above,
          // and react which is in the main vendor chunk below — both one-way deps).
          if (/\/recharts\//.test(id)) return "vendor-recharts";

          // Everything else (react, react-dom, react-router, @radix-ui,
          // @floating-ui, @tanstack, lucide-react, cmdk, vaul, etc.) goes into
          // ONE vendor chunk. Keeping them together eliminates the cross-chunk
          // circular dep between vendor-react ↔ vendor-misc that caused
          // "Cannot read properties of undefined (reading 'forwardRef')" crashes.
          return "vendor";
        },
      },
    },
  },
}));
