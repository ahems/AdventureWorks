import React from 'react';
import { Link } from 'react-router-dom';
import { Bike, Mail, MapPin, Phone } from 'lucide-react';
import { useCategories } from '@/hooks/useProducts';

const Footer: React.FC = () => {
  const { data: categories = [] } = useCategories();

  return (
    <footer className="bg-doodle-text text-doodle-bg mt-16">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="space-y-4">
            <Link to="/" className="flex items-center gap-2">
              <div className="bg-doodle-bg p-1.5 border-2 border-doodle-bg">
                <Bike className="w-6 h-6 text-doodle-text" />
              </div>
              <span className="font-doodle text-xl font-bold">
                Adventure<span className="text-doodle-accent">Works</span>
              </span>
            </Link>
            <p className="font-doodle text-sm opacity-80">
              Your one-stop shop for outdoor adventure gear. Quality bikes, components, and accessories since 2001.
            </p>
          </div>

          {/* Categories */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">Shop</h3>
            <ul className="space-y-2">
              {categories.map((category) => (
                <li key={category.ProductCategoryID}>
                  <Link
                    to={`/category/${category.ProductCategoryID}`}
                    className="font-doodle text-sm opacity-80 hover:opacity-100 hover:text-doodle-accent transition-colors"
                  >
                    * {category.Name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Quick Links */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">Quick Links</h3>
            <ul className="space-y-2">
              <li>
                <Link to="/cart" className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors">
                  * Shopping Cart
                </Link>
              </li>
              <li>
                <Link to="/order-tracking" className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors">
                  * Track Order
                </Link>
              </li>
              <li>
                <Link to="/returns" className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors">
                  * Returns Policy
                </Link>
              </li>
              <li>
                <Link to="/faq" className="font-doodle text-sm opacity-80 hover:opacity-100 transition-colors">
                  * FAQ
                </Link>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="font-doodle text-lg font-bold mb-4 text-doodle-accent">Contact Us</h3>
            <ul className="space-y-3">
              <li className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-1 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  1 Adventure Way<br />
                  Bothell, WA 98011
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="w-4 h-4 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  (555) 123-4567
                </span>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="w-4 h-4 flex-shrink-0" />
                <span className="font-doodle text-sm opacity-80">
                  hello@adventureworks.com
                </span>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-6 border-t-2 border-dashed border-doodle-bg/30">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="font-doodle text-sm opacity-60">
              © 2024 Adventure Works. All rights reserved. (Demo Store)
            </p>
            <p className="font-doodle text-sm opacity-60">
              Built with ♥ and DoodleCSS vibes
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
