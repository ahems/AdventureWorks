import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle, Package, Truck, MapPin, Mail } from "lucide-react";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

interface OrderItem {
  ProductID: number;
  Name: string;
  ListPrice: number;
  quantity: number;
}

interface Order {
  id: string;
  items: OrderItem[];
  shipping: {
    firstName: string;
    lastName: string;
    email: string;
    address: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  paymentMethod: string;
  shippingMethodName: string;
  subtotal: number;
  shippingCost: number;
  tax: number;
  total: number;
  currencyCode: string;
  currencySymbol: string;
  date: string;
}

const OrderConfirmationPage: React.FC = () => {
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    const savedOrder = localStorage.getItem("lastOrder");
    if (savedOrder) {
      setOrder(JSON.parse(savedOrder));
    }
  }, []);

  if (!order) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 container mx-auto px-4 py-12">
          <div className="max-w-md mx-auto text-center">
            <div className="doodle-card p-12">
              <Package className="w-20 h-20 mx-auto mb-6 text-doodle-text/40" />
              <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">
                No Order Found
              </h1>
              <p className="font-doodle text-doodle-text/70 mb-8">
                Looks like you haven't placed an order yet.
              </p>
              <Link
                to="/"
                className="doodle-button doodle-button-primary inline-block"
              >
                Start Shopping
              </Link>
            </div>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  const estimatedDelivery = new Date();
  estimatedDelivery.setDate(estimatedDelivery.getDate() + 5);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <section className="container mx-auto px-4 py-12">
          {/* Success Header */}
          <div className="max-w-2xl mx-auto text-center mb-12">
            <div className="inline-flex items-center justify-center w-20 h-20 bg-doodle-green/20 rounded-full mb-6">
              <CheckCircle className="w-12 h-12 text-doodle-green" />
            </div>
            <h1 className="font-doodle text-4xl md:text-5xl font-bold text-doodle-text mb-4">
              Order Confirmed!
            </h1>
            <p className="font-doodle text-lg text-doodle-text/70">
              Thank you for your order. We've sent a confirmation email to{" "}
              <span className="font-bold text-doodle-text">
                {order.shipping.email}
              </span>
            </p>
          </div>

          <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Order Details Card */}
            <div className="doodle-card p-6">
              <div className="flex items-center gap-3 mb-6">
                <Package className="w-6 h-6 text-doodle-accent" />
                <h2 className="font-doodle text-xl font-bold text-doodle-text">
                  Order Details
                </h2>
              </div>

              <div className="space-y-4">
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">Order Number</span>
                  <span className="font-bold text-doodle-accent">
                    {order.id}
                  </span>
                </div>
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">Order Date</span>
                  <span>{new Date(order.date).toLocaleDateString()}</span>
                </div>
                <div className="flex justify-between font-doodle">
                  <span className="text-doodle-text/70">Payment Method</span>
                  <span className="capitalize">{order.paymentMethod}</span>
                </div>

                <hr className="border-dashed border-doodle-text/30" />

                {/* Items */}
                <div className="space-y-3">
                  {order.items.map((item) => (
                    <div
                      key={item.ProductID}
                      className="flex justify-between font-doodle text-sm"
                    >
                      <span className="text-doodle-text/70">
                        {item.Name} × {item.quantity}
                      </span>
                      <span>
                        {order.currencySymbol}
                        {(item.ListPrice * item.quantity).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>

                <hr className="border-dashed border-doodle-text/30" />

                <div className="space-y-2 font-doodle text-sm">
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">Subtotal</span>
                    <span>
                      {order.currencySymbol}
                      {order.subtotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">
                      Shipping ({order.shippingMethodName})
                    </span>
                    <span>
                      {order.shippingCost === 0
                        ? "FREE"
                        : `${order.currencySymbol}${order.shippingCost.toFixed(
                            2
                          )}`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-doodle-text/70">Tax</span>
                    <span>
                      {order.currencySymbol}
                      {order.tax.toFixed(2)}
                    </span>
                  </div>
                  <hr className="border-dashed border-doodle-text/30" />
                  <div className="flex justify-between text-lg font-bold">
                    <span>Total</span>
                    <span className="text-doodle-green">
                      {order.currencySymbol}
                      {order.total.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Shipping & Delivery Card */}
            <div className="space-y-6">
              {/* Shipping Address */}
              <div className="doodle-card p-6">
                <div className="flex items-center gap-3 mb-4">
                  <MapPin className="w-6 h-6 text-doodle-accent" />
                  <h2 className="font-doodle text-xl font-bold text-doodle-text">
                    Shipping Address
                  </h2>
                </div>
                <div className="font-doodle text-doodle-text/70 space-y-1">
                  <p className="font-bold text-doodle-text">
                    {order.shipping.firstName} {order.shipping.lastName}
                  </p>
                  <p>{order.shipping.address}</p>
                  <p>
                    {order.shipping.city}, {order.shipping.state}{" "}
                    {order.shipping.zipCode}
                  </p>
                  <p>{order.shipping.country}</p>
                </div>
              </div>

              {/* Estimated Delivery */}
              <div className="doodle-card p-6">
                <div className="flex items-center gap-3 mb-4">
                  <Truck className="w-6 h-6 text-doodle-accent" />
                  <h2 className="font-doodle text-xl font-bold text-doodle-text">
                    Estimated Delivery
                  </h2>
                </div>
                <p className="font-doodle text-2xl font-bold text-doodle-green">
                  {estimatedDelivery.toLocaleDateString("en-US", {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
                <p className="font-doodle text-sm text-doodle-text/70 mt-2">
                  You'll receive tracking information via email once your order
                  ships.
                </p>
              </div>

              {/* Email Confirmation */}
              <div className="doodle-card p-6 bg-doodle-accent/5">
                <div className="flex items-center gap-3">
                  <Mail className="w-6 h-6 text-doodle-accent" />
                  <div>
                    <p className="font-doodle font-bold text-doodle-text">
                      Confirmation Sent
                    </p>
                    <p className="font-doodle text-sm text-doodle-text/70">
                      Check your email for order details
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Continue Shopping */}
          <div className="max-w-4xl mx-auto mt-12 text-center">
            <Link
              to="/"
              className="doodle-button doodle-button-primary inline-block px-8 py-3 text-lg"
            >
              Continue Shopping
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default OrderConfirmationPage;
