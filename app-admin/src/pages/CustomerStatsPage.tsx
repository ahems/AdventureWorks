import React from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft, BarChart3 } from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { useAuth } from "@/context/AuthContext";
import { useAdminCustomers } from "@/hooks/useAdminCustomers";
import { useAdminOrders } from "@/hooks/useAdminOrders";
import CustomerStatsDashboard from "@/components/CustomerStatsDashboard";
import CustomerCountryMap from "@/components/CustomerCountryMap";

const CustomerStatsPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const { data: apiData, isLoading: customersLoading } = useAdminCustomers();
  const { data: ordersData } = useAdminOrders();
  const customers = React.useMemo(() => apiData?.items ?? [], [apiData]);
  const orders = React.useMemo(() => ordersData?.items ?? [], [ordersData]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">
        <section className="container mx-auto px-4 pb-4">
          <div className="doodle-card p-6">
            <div className="flex items-center gap-4">
              <Link
                to="/customers"
                className="inline-flex items-center gap-2 font-doodle text-sm text-doodle-text/60 hover:text-doodle-accent transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Customers
              </Link>
              <h1 className="font-doodle text-3xl font-bold text-doodle-text flex items-center gap-2">
                <BarChart3 className="w-7 h-7" />
                Customer Statistics
              </h1>
            </div>
            {customersLoading && (
              <p className="font-doodle text-sm text-doodle-text/60 mt-4">
                Loading customer data…
              </p>
            )}
          </div>
        </section>

        <CustomerStatsDashboard customers={customers} orders={orders} />
        <CustomerCountryMap customers={customers} />
      </main>
      <Footer />
    </div>
  );
};

export default CustomerStatsPage;
