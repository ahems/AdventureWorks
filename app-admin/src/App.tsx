import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { AuthProvider } from "@/context/AuthContext";
import Index from "./pages/Index";
import CategoryPage from "./pages/CategoryPage";
import ProductPage from "./pages/ProductPage";
import ProductsPage from "./pages/ProductsPage";
import CategoriesPage from "./pages/CategoriesPage";
import LoginPage from "./pages/LoginPage";
import CustomersPage from "./pages/CustomersPage";
import OrdersPage from "./pages/OrdersPage";
import ReviewsPage from "./pages/ReviewsPage";
import PromotionsPage from "./pages/PromotionsPage";
import CulturesPage from "./pages/CulturesPage";
import CurrenciesPage from "./pages/CurrenciesPage";
import StaleCartsPage from "./pages/StaleCartsPage";
import SearchPage from "./pages/SearchPage";
import UtilitiesPage from "./pages/UtilitiesPage";
import CustomerStatsPage from "./pages/CustomerStatsPage";
import NotFound from "./pages/NotFound";
import StoresPage from "./pages/StoresPage";
import InventoryTransactionsPage from "./pages/InventoryTransactionsPage";
import ReportsPage from "./pages/ReportsPage";
import ProductProfitabilityPage from "./pages/ProductProfitabilityPage";
import LossMakersPage from "./pages/LossMakersPage";
import SlowMoversPage from "./pages/SlowMoversPage";
import GenerateOrderPage from "./pages/GenerateOrderPage";

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/categories" element={<CategoriesPage />} />
              <Route path="/category/:categoryId" element={<CategoryPage />} />
              <Route path="/product/:productId" element={<ProductPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route
                path="/customers/:customerId"
                element={<CustomersPage />}
              />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/orders/:orderId" element={<OrdersPage />} />
              <Route path="/stores" element={<StoresPage />} />
              <Route path="/reviews" element={<ReviewsPage />} />
              <Route path="/promotions" element={<PromotionsPage />} />
              <Route path="/cultures" element={<CulturesPage />} />
              <Route path="/currencies" element={<CurrenciesPage />} />
              <Route path="/stale-carts" element={<StaleCartsPage />} />
              <Route path="/utilities" element={<UtilitiesPage />} />
              <Route path="/customer-stats" element={<CustomerStatsPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route
                path="/inventory-transactions"
                element={<InventoryTransactionsPage />}
              />
              <Route path="/reports" element={<ReportsPage />} />
              <Route
                path="/product-profitability"
                element={<ProductProfitabilityPage />}
              />
              <Route path="/loss-makers" element={<LossMakersPage />} />
              <Route path="/slow-movers" element={<SlowMoversPage />} />
              <Route path="/generate-order" element={<GenerateOrderPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
