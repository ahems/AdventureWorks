import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
} from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AuthProvider } from "@/context/AuthContext";
import { useAuth } from "@/context/AuthContext";
import ProductionHeader from "@/components/ProductionHeader";
import Footer from "@/components/Footer";
import LoginPage from "@/pages/LoginPage";
import Dashboard from "@/pages/Dashboard";
import DefineProducts from "@/pages/define/DefineProducts";
import DefineProductDetail from "@/pages/define/DefineProductDetail";
import DefineModels from "@/pages/define/DefineModels";
import DefineModelDetail from "@/pages/define/DefineModelDetail";

import EngineerBOM from "@/pages/engineer/EngineerBOM";
import EngineerBOMDetail from "@/pages/engineer/EngineerBOMDetail";
import EngineerRouting from "@/pages/engineer/EngineerRouting";
import EngineerLocations from "@/pages/engineer/EngineerLocations";
import EngineerLocationDetail from "@/pages/engineer/EngineerLocationDetail";
import PlanWorkOrders from "@/pages/plan/PlanWorkOrders";
import PlanWorkOrderDetail from "@/pages/plan/PlanWorkOrderDetail";
import PlanSchedule from "@/pages/plan/PlanSchedule";
import PlanningIntelligence from "@/pages/plan/PlanningIntelligence";
import PlanDemand from "@/pages/plan/PlanDemand";
import ManufacturingDashboard from "@/pages/execute/ManufacturingDashboard";
import ExecuteShopFloor from "@/pages/execute/ExecuteShopFloor";
import ExecuteWorkOrder from "@/pages/execute/ExecuteWorkOrder";
import FinishedGoodTracker from "@/pages/execute/FinishedGoodTracker";
import WorkforcePage from "@/pages/execute/WorkforcePage";
import SupplyChain from "@/pages/supply/SupplyChain";
import VendorDetail from "@/pages/supply/VendorDetail";
import PurchaseOrderDetail from "@/pages/supply/PurchaseOrderDetail";
import ProductPurchaseOrders from "@/pages/supply/ProductPurchaseOrders";

import ReceiveInventory from "@/pages/receive/ReceiveInventory";
import ReceiveProductInventory from "@/pages/receive/ReceiveProductInventory";
import ReceiveCosting from "@/pages/receive/ReceiveCosting";
import ReceiveProductCost from "@/pages/receive/ReceiveProductCost";
import SettingsPage from "@/pages/Settings";
import ManufacturingAgentPage from "@/pages/ManufacturingAgentPage";
import WarehouseDashboard from "@/pages/warehouse/WarehouseDashboard";
import WarehouseFloor from "@/pages/warehouse/WarehouseFloor";
import WarehouseWorkforce from "@/pages/warehouse/WarehouseWorkforce";
import WarehouseConfig from "@/pages/warehouse/WarehouseConfig";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const AuthGuard: React.FC = () => {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return (
    <div className="min-h-screen flex flex-col">
      <ProductionHeader />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
};

const App = () => (
  <>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<AuthGuard />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/define" element={<DefineProducts />} />
                <Route
                  path="/define/products/:id"
                  element={<DefineProductDetail />}
                />
                <Route path="/define/models" element={<DefineModels />} />
                <Route
                  path="/define/models/:id"
                  element={<DefineModelDetail />}
                />

                <Route path="/engineer" element={<EngineerBOM />} />
                <Route
                  path="/engineer/bom/:productId"
                  element={<EngineerBOMDetail />}
                />
                <Route
                  path="/engineer/routing/:productId"
                  element={<EngineerRouting />}
                />
                <Route
                  path="/engineer/locations"
                  element={<EngineerLocations />}
                />
                <Route
                  path="/engineer/locations/:id"
                  element={<EngineerLocationDetail />}
                />
                <Route path="/plan" element={<PlanWorkOrders />} />
                <Route
                  path="/plan/work-orders/:id"
                  element={<PlanWorkOrderDetail />}
                />
                <Route path="/plan/schedule" element={<PlanSchedule />} />
                <Route
                  path="/plan/intelligence"
                  element={<PlanningIntelligence />}
                />
                <Route path="/plan/demand" element={<PlanDemand />} />
                <Route path="/execute" element={<ManufacturingDashboard />} />
                <Route
                  path="/execute/shop-floor"
                  element={<ExecuteShopFloor />}
                />
                <Route
                  path="/execute/work-order/:id"
                  element={<ExecuteWorkOrder />}
                />
                <Route
                  path="/execute/tracker"
                  element={<FinishedGoodTracker />}
                />
                <Route path="/execute/workforce" element={<WorkforcePage />} />
                <Route path="/supply" element={<SupplyChain />} />
                <Route
                  path="/supply/vendors/:vendorId"
                  element={<VendorDetail />}
                />
                <Route
                  path="/supply/orders/:orderId"
                  element={<PurchaseOrderDetail />}
                />
                <Route
                  path="/supply/product/:productId"
                  element={<ProductPurchaseOrders />}
                />

                <Route path="/receive" element={<ReceiveInventory />} />
                <Route
                  path="/receive/inventory/:productId"
                  element={<ReceiveProductInventory />}
                />
                <Route path="/receive/costing" element={<ReceiveCosting />} />
                <Route
                  path="/receive/costing/:productId"
                  element={<ReceiveProductCost />}
                />

                <Route path="/settings" element={<SettingsPage />} />
                <Route
                  path="/manufacturing-agent"
                  element={<ManufacturingAgentPage />}
                />

                <Route path="/warehouse" element={<WarehouseDashboard />} />
                <Route path="/warehouse/floor" element={<WarehouseFloor />} />
                <Route
                  path="/warehouse/workforce"
                  element={<WarehouseWorkforce />}
                />
                <Route path="/warehouse/config" element={<WarehouseConfig />} />

                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </>
);

export default App;
