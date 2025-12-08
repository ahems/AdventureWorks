import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCcw, Clock, Package, CheckCircle, AlertCircle, Mail } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

const ReturnsPage: React.FC = () => {
  const returnSteps = [
    {
      icon: <Mail className="w-6 h-6" />,
      title: 'Contact Us',
      description: 'Email us at returns@adventureworks.com or call (555) 123-4567 to initiate your return.',
    },
    {
      icon: <Package className="w-6 h-6" />,
      title: 'Pack It Up',
      description: 'Securely pack the item in its original packaging with all tags and accessories.',
    },
    {
      icon: <RotateCcw className="w-6 h-6" />,
      title: 'Ship It Back',
      description: 'Use the prepaid shipping label we provide or ship via your preferred carrier.',
    },
    {
      icon: <CheckCircle className="w-6 h-6" />,
      title: 'Get Refunded',
      description: 'Once inspected, refunds are processed within 5-7 business days to your original payment method.',
    },
  ];

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="container mx-auto px-4 py-4">
          <Link 
            to="/" 
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Shop
          </Link>
        </div>

        <section className="container mx-auto px-4 pb-12">
          <div className="max-w-3xl mx-auto">
            {/* Header */}
            <div className="text-center mb-12">
              <span className="text-5xl mb-4 block">🔄</span>
              <h1 className="font-doodle text-3xl md:text-4xl font-bold text-doodle-text mb-4">
                Returns & Exchanges
              </h1>
              <p className="font-doodle text-lg text-doodle-text/70">
                Not satisfied? No problem! We make returns easy.
              </p>
            </div>

            {/* Key Info Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
              <div className="doodle-card p-6 text-center">
                <Clock className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">30-Day Returns</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Return within 30 days of delivery
                </p>
              </div>
              <div className="doodle-card p-6 text-center">
                <Package className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">Free Returns</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Prepaid labels for US orders
                </p>
              </div>
              <div className="doodle-card p-6 text-center">
                <RotateCcw className="w-10 h-10 mx-auto mb-3 text-doodle-accent" />
                <h3 className="font-doodle font-bold text-doodle-text mb-1">Easy Exchanges</h3>
                <p className="font-doodle text-sm text-doodle-text/70">
                  Swap for a different size or color
                </p>
              </div>
            </div>

            {/* How to Return */}
            <div className="doodle-card p-6 md:p-8 mb-8">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-6">
                How to Return an Item
              </h2>
              <div className="space-y-6">
                {returnSteps.map((step, index) => (
                  <div key={index} className="flex gap-4">
                    <div className="flex-shrink-0 w-12 h-12 bg-doodle-accent/10 border-2 border-dashed border-doodle-accent rounded-full flex items-center justify-center text-doodle-accent">
                      {step.icon}
                    </div>
                    <div className="flex-1 pt-1">
                      <h3 className="font-doodle font-bold text-doodle-text">
                        Step {index + 1}: {step.title}
                      </h3>
                      <p className="font-doodle text-doodle-text/70 mt-1">
                        {step.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Policy Details */}
            <div className="doodle-card p-6 md:p-8 mb-8">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-6">
                Return Policy Details
              </h2>
              
              <div className="space-y-6">
                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    ✓ Eligible for Return
                  </h3>
                  <ul className="font-doodle text-doodle-text/70 space-y-1 ml-4">
                    <li>• Unused items in original packaging</li>
                    <li>• Items with all tags attached</li>
                    <li>• Items returned within 30 days of delivery</li>
                    <li>• Defective or damaged items (any time)</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    ✗ Not Eligible for Return
                  </h3>
                  <ul className="font-doodle text-doodle-text/70 space-y-1 ml-4">
                    <li>• Used or worn items</li>
                    <li>• Items without original packaging</li>
                    <li>• Custom or personalized items</li>
                    <li>• Items marked as final sale</li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-doodle font-bold text-doodle-text mb-2">
                    Bike Returns
                  </h3>
                  <p className="font-doodle text-doodle-text/70">
                    Bikes may be returned within 14 days of delivery if unassembled and in original packaging. 
                    Assembled bikes are subject to a 15% restocking fee. Please contact us for special arrangements.
                  </p>
                </div>
              </div>
            </div>

            {/* Exchange Info */}
            <div className="doodle-card p-6 md:p-8 mb-8 bg-doodle-accent/5">
              <h2 className="font-doodle text-2xl font-bold text-doodle-text mb-4">
                Prefer an Exchange?
              </h2>
              <p className="font-doodle text-doodle-text/70 mb-4">
                Need a different size or color? Exchanges are free and easy! Just mention "exchange" when you 
                contact us and we'll ship your new item as soon as we receive your return.
              </p>
              <p className="font-doodle text-sm text-doodle-text/50">
                Note: Exchanges are subject to availability. If your preferred item is out of stock, 
                we'll process a full refund instead.
              </p>
            </div>

            {/* Contact */}
            <div className="doodle-card p-6 md:p-8">
              <div className="flex items-start gap-4">
                <AlertCircle className="w-8 h-8 text-doodle-accent flex-shrink-0 mt-1" />
                <div>
                  <h2 className="font-doodle text-xl font-bold text-doodle-text mb-2">
                    Questions About Your Return?
                  </h2>
                  <p className="font-doodle text-doodle-text/70 mb-4">
                    Our customer support team is here to help! Reach out to us and we'll get back to you 
                    within 24 hours.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <a 
                      href="mailto:returns@adventureworks.com" 
                      className="doodle-button doodle-button-primary inline-flex items-center gap-2"
                    >
                      <Mail className="w-4 h-4" />
                      Email Support
                    </a>
                    <Link to="/order-tracking" className="doodle-button inline-flex items-center gap-2">
                      <Package className="w-4 h-4" />
                      Track Your Order
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
};

export default ReturnsPage;
