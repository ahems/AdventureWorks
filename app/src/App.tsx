import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { CartProvider } from "@/context/CartContext";
import { AuthProvider } from "@/context/AuthContext";
import { WishlistProvider } from "@/context/WishlistContext";
import { RecentlyViewedProvider } from "@/context/RecentlyViewedContext";
import { CompareProvider } from "@/context/CompareContext";
import { LanguageProvider } from "@/context/LanguageContext";
import { CurrencyProvider } from "@/context/CurrencyContext";
import { UnitMeasureProvider } from "@/context/UnitMeasureContext";
import { ProductNamesProvider } from "@/context/ProductNamesContext";
import CompareBar from "@/components/CompareBar";
import { AIChatOverlay } from "@/components/AIChatOverlay";
import { AppInsightsContext } from "@microsoft/applicationinsights-react-js";
import { initAppInsights, reactPlugin } from "@/lib/appInsights";
import "./i18n"; // Initialize i18next
import Index from "./pages/Index";
import CategoryPage from "./pages/CategoryPage";
import ProductPage from "./pages/ProductPage";
import CartPage from "./pages/CartPage";
import CheckoutPage from "./pages/CheckoutPage";
import OrderConfirmationPage from "./pages/OrderConfirmationPage";
import AuthPage from "./pages/AuthPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import AccountPage from "./pages/AccountPage";
import SalePage from "./pages/SalePage";
import SearchPage from "./pages/SearchPage";
import WishlistPage from "./pages/WishlistPage";
import OrderTrackingPage from "./pages/OrderTrackingPage";
import ReturnsPage from "./pages/ReturnsPage";
import FAQPage from "./pages/FAQPage";
import ComparePage from "./pages/ComparePage";
import HealthCheckPage from "./pages/HealthCheckPage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

// Initialize Application Insights
initAppInsights();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AppInsightsContext.Provider value={reactPlugin}>
      <TooltipProvider>
        <LanguageProvider>
          <CurrencyProvider>
            <UnitMeasureProvider>
              <ProductNamesProvider>
              <AuthProvider>
                <WishlistProvider>
                  <RecentlyViewedProvider>
                    <CompareProvider>
                      <CartProvider>
                        <Toaster />
                        <Sonner />
                        <BrowserRouter
                          future={{
                            v7_startTransition: true,
                            v7_relativeSplatPath: true,
                          }}
                        >
                          <CompareBar />
                          <AIChatOverlay />
                          <Routes>
                            <Route path="/" element={<Index />} />
                            <Route
                              path="/category/:categoryId"
                              element={<CategoryPage />}
                            />
                            <Route
                              path="/product/:productId"
                              element={<ProductPage />}
                            />
                            <Route path="/cart" element={<CartPage />} />
                            <Route
                              path="/checkout"
                              element={<CheckoutPage />}
                            />
                            <Route
                              path="/order-confirmation"
                              element={<OrderConfirmationPage />}
                            />
                            <Route path="/auth" element={<AuthPage />} />
                            <Route
                              path="/reset-password"
                              element={<ResetPasswordPage />}
                            />
                            <Route path="/account" element={<AccountPage />} />
                            <Route path="/sale" element={<SalePage />} />
                            <Route path="/search" element={<SearchPage />} />
                            <Route
                              path="/wishlist"
                              element={<WishlistPage />}
                            />
                            <Route
                              path="/order-tracking"
                              element={<OrderTrackingPage />}
                            />
                            <Route
                              path="/order-tracking/:orderId"
                              element={<OrderTrackingPage />}
                            />
                            <Route path="/returns" element={<ReturnsPage />} />
                            <Route path="/faq" element={<FAQPage />} />
                            <Route path="/compare" element={<ComparePage />} />
                            <Route
                              path="/health"
                              element={<HealthCheckPage />}
                            />
                            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                            <Route path="*" element={<NotFound />} />
                          </Routes>
                        </BrowserRouter>
                      </CartProvider>
                    </CompareProvider>
                  </RecentlyViewedProvider>
                </WishlistProvider>
              </AuthProvider>
              </ProductNamesProvider>
            </UnitMeasureProvider>
          </CurrencyProvider>
        </LanguageProvider>
      </TooltipProvider>
    </AppInsightsContext.Provider>
  </QueryClientProvider>
);

export default App;
