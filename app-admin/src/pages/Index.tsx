import React from "react";
import { Link } from "react-router-dom";
import {
  Package,
  Users,
  ShoppingBag,
  Star,
  TrendingUp,
  AlertCircle,
  Clock,
  Loader2,
  Store,
  Tag,
  BarChart3,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import AiAgentChat from "@/components/AiAgentChat";
import { useAuth } from "@/context/AuthContext";
import {
  useDashboardStats,
  getOrderStatusLabel,
} from "@/hooks/useDashboardStats";

const Index: React.FC = () => {
  const { isAuthenticated, user } = useAuth();
  const { data: stats, isLoading: statsLoading } = useDashboardStats();

  const totalProducts = stats?.totalProducts?.toLocaleString() ?? "—";
  const totalCustomers = stats?.totalCustomers?.toLocaleString() ?? "—";
  const totalOrders = stats?.totalOrders?.toLocaleString() ?? "—";
  const pendingOrders = stats?.pendingOrders ?? 0;
  const totalReviews = stats?.totalReviews?.toLocaleString() ?? "—";
  const recentOrders = stats?.recentOrders ?? [];

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col bg-doodle-bg">
        <AdminHeader />
        <main className="flex-1 flex items-center justify-center p-4">
          <div className="max-w-2xl mx-auto text-center">
            <div className="doodle-card p-8 md:p-12">
              <span className="text-7xl block mb-6">🏔️</span>
              <h1 className="font-doodle text-3xl md:text-5xl font-bold text-doodle-text mb-4">
                Welcome to Adventure
                <span className="text-doodle-accent">Works</span>
              </h1>
              <h2 className="font-doodle text-xl md:text-2xl text-doodle-text/80 mb-6">
                Internal Admin Portal
              </h2>
              <p className="font-doodle text-lg text-doodle-text/70 mb-8 leading-relaxed">
                This portal is for AdventureWorks employees only. Manage
                products, customers, orders, and reviews from one central
                location.
              </p>
              <div className="doodle-border-light p-6 mb-8 bg-doodle-text/5">
                <p className="font-doodle text-doodle-text/70 mb-4">
                  Please sign in with your corporate credentials to access the
                  admin dashboard.
                </p>
                <Link
                  to="/login"
                  className="doodle-button doodle-button-primary text-lg px-8 py-3 inline-flex items-center gap-2"
                >
                  Employee Login
                </Link>
              </div>
              <p className="font-doodle text-sm text-doodle-text/50">
                Need access? Contact your IT department or manager.
              </p>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1">
        {/* Welcome Section */}
        <section className="container mx-auto px-4 py-8">
          <div className="doodle-card p-6 md:p-8">
            <h1 className="font-doodle text-2xl md:text-4xl font-bold text-doodle-text mb-2">
              Welcome back, {user?.firstName}! 👋
            </h1>
            <p className="font-doodle text-doodle-text/70">
              Here's what's happening with AdventureWorks today.
            </p>
          </div>
        </section>

        {/* Stats Grid */}
        <section className="container mx-auto px-4 pb-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <Link
              to="/category/1"
              className="doodle-card p-4 md:p-6 hover:border-doodle-accent transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <Package className="w-8 h-8 text-doodle-accent group-hover:scale-110 transition-transform" />
                <TrendingUp className="w-4 h-4 text-doodle-green" />
              </div>
              <p className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                {totalProducts}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Total Products
              </p>
            </Link>

            <Link
              to="/customers"
              className="doodle-card p-4 md:p-6 hover:border-doodle-accent transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <Users className="w-8 h-8 text-doodle-green group-hover:scale-110 transition-transform" />
                <TrendingUp className="w-4 h-4 text-doodle-green" />
              </div>
              <p className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                {totalCustomers}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">
                Customers
              </p>
            </Link>

            <Link
              to="/orders"
              className="doodle-card p-4 md:p-6 hover:border-doodle-accent transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <ShoppingBag className="w-8 h-8 text-doodle-blue group-hover:scale-110 transition-transform" />
                {pendingOrders > 0 && (
                  <span className="bg-doodle-accent text-white font-doodle text-xs font-bold px-2 py-1 border-2 border-doodle-text">
                    {pendingOrders} pending
                  </span>
                )}
              </div>
              <p className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                {totalOrders}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">Orders</p>
            </Link>

            <Link
              to="/reviews"
              className="doodle-card p-4 md:p-6 hover:border-doodle-accent transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <Star className="w-8 h-8 text-doodle-accent group-hover:scale-110 transition-transform" />
              </div>
              <p className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text">
                {totalReviews}
              </p>
              <p className="font-doodle text-sm text-doodle-text/60">Reviews</p>
            </Link>
          </div>
        </section>

        {/* AI Agent Section */}
        <section className="container mx-auto px-4 pb-8">
          <div className="mb-4">
            <h2 className="font-doodle text-xl font-bold text-doodle-text flex items-center gap-2">
              🤖 AI Data Assistant
            </h2>
            <p className="font-doodle text-sm text-doodle-text/60">
              Ask questions about your business data using natural language
            </p>
          </div>
          <AiAgentChat />
        </section>

        {/* Quick Actions & Recent Orders */}
        <section className="container mx-auto px-4 pb-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Quick Actions */}
            <div className="doodle-card p-6">
              <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4 flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-doodle-accent" />
                Quick Actions
              </h2>
              <div className="space-y-3">
                <Link
                  to="/promotions"
                  className="flex items-center justify-between p-3 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors"
                >
                  <span className="font-doodle text-doodle-text flex items-center gap-2">
                    <Tag className="w-4 h-4 text-doodle-purple" />
                    Manage Promotions
                  </span>
                </Link>
                <Link
                  to="/reports"
                  className="flex items-center justify-between p-3 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors"
                >
                  <span className="font-doodle text-doodle-text flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-doodle-blue" />
                    View Reports
                  </span>
                </Link>
                <Link
                  to="/reviews"
                  className="flex items-center justify-between p-3 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors"
                >
                  <span className="font-doodle text-doodle-text">
                    Moderate Reviews
                  </span>
                  <span className="font-doodle text-sm text-doodle-accent">
                    {totalReviews} to review
                  </span>
                </Link>
                <Link
                  to="/category/1"
                  className="flex items-center justify-between p-3 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors"
                >
                  <span className="font-doodle text-doodle-text flex items-center gap-2">
                    <Package className="w-4 h-4 text-doodle-accent" />
                    Browse Bikes
                  </span>
                </Link>
                <Link
                  to="/stores"
                  className="flex items-center justify-between p-3 border-2 border-doodle-accent/40 hover:border-doodle-accent transition-colors bg-doodle-accent/5"
                >
                  <span className="font-doodle text-doodle-text flex items-center gap-2">
                    <Store className="w-4 h-4 text-doodle-accent" />
                    B2B Store Orders
                  </span>
                  <span className="font-doodle text-xs text-doodle-accent font-bold">
                    Place order →
                  </span>
                </Link>
              </div>
            </div>

            {/* Recent Orders */}
            <div className="doodle-card p-6">
              <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4 flex items-center gap-2">
                <Clock className="w-5 h-5 text-doodle-green" />
                Recent Orders
              </h2>
              {statsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-doodle-accent" />
                </div>
              ) : (
                <div className="space-y-3">
                  {recentOrders.map((order) => {
                    const statusLabel = getOrderStatusLabel(order.Status);
                    return (
                      <Link
                        key={order.SalesOrderID}
                        to={`/orders?orderId=${order.SalesOrderID}`}
                        className="flex items-center justify-between p-3 border-2 border-doodle-text/20 hover:border-doodle-accent transition-colors"
                      >
                        <div>
                          <span className="font-doodle text-doodle-text font-bold">
                            #{order.SalesOrderID}
                          </span>
                          <p className="font-doodle text-xs text-doodle-text/60">
                            {new Date(order.OrderDate).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-doodle text-xs px-2 py-1 border-2 border-doodle-text ${
                              order.Status === 5
                                ? "bg-doodle-blue/20 text-doodle-blue"
                                : order.Status === 6
                                  ? "bg-doodle-accent/20 text-doodle-accent"
                                  : "bg-doodle-text/10 text-doodle-text"
                            }`}
                          >
                            {statusLabel}
                          </span>
                          <span className="font-doodle text-sm text-doodle-text">
                            ${order.TotalDue.toFixed(2)}
                          </span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
              <Link
                to="/orders"
                className="block mt-4 text-center font-doodle text-doodle-accent hover:text-doodle-green transition-colors"
              >
                View all orders →
              </Link>
            </div>
          </div>
        </section>

        {/* Business Intelligence Section */}
        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <h2 className="font-doodle text-xl font-bold text-doodle-text mb-4 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-doodle-blue" />
              Business Intelligence
            </h2>
            <p className="font-doodle text-sm text-doodle-text/60 mb-4">
              Access reports and analytics to drive data-informed decisions.
            </p>
            <Link
              to="/reports"
              className="doodle-button doodle-button-primary inline-flex items-center gap-2"
            >
              <BarChart3 className="w-4 h-4" />
              View Reports
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default Index;
