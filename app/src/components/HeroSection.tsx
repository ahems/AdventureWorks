import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';

const HeroSection: React.FC = () => {
  return (
    <section className="relative overflow-hidden py-12 md:py-20">
      {/* Decorative Elements */}
      <div className="absolute top-10 left-10 text-6xl opacity-20 animate-float">✨</div>
      <div className="absolute bottom-10 right-10 text-6xl opacity-20 animate-float" style={{ animationDelay: '1s' }}>🚴</div>
      <div className="absolute top-1/2 left-1/4 text-4xl opacity-10 animate-float" style={{ animationDelay: '0.5s' }}>⭐</div>
      <div className="absolute top-1/3 right-1/4 text-4xl opacity-10 animate-float" style={{ animationDelay: '1.5s' }}>🏔️</div>

      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 doodle-border-light px-4 py-2 mb-6 bg-doodle-bg">
            <Sparkles className="w-4 h-4 text-doodle-accent" />
            <span className="font-doodle text-sm text-doodle-text">
              Adventure Awaits!
            </span>
          </div>

          {/* Main Heading */}
          <h1 className="font-doodle text-4xl md:text-6xl lg:text-7xl font-bold text-doodle-text mb-6 leading-tight">
            Gear Up for Your{' '}
            <span className="relative inline-block">
              <span className="text-doodle-accent">Adventure</span>
              <svg className="absolute -bottom-2 left-0 w-full" viewBox="0 0 200 12" fill="none">
                <path 
                  d="M2 8C20 4 40 6 60 5C80 4 100 7 120 6C140 5 160 8 180 6C190 5 195 6 198 7" 
                  stroke="#FF5E5B" 
                  strokeWidth="3" 
                  strokeLinecap="round"
                  className="opacity-60"
                />
              </svg>
            </span>
          </h1>

          {/* Subtitle */}
          <p className="font-doodle text-lg md:text-xl text-doodle-text/80 mb-8 max-w-2xl mx-auto">
            Premium bikes, components, clothing & accessories for outdoor enthusiasts. 
            Hand-picked gear for every trail, road, and journey ahead.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/category/1"
              className="doodle-button doodle-button-primary text-lg px-8 py-3 inline-flex items-center justify-center gap-2"
            >
              Shop Bikes
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              to="/category/4"
              className="doodle-button text-lg px-8 py-3 inline-flex items-center justify-center gap-2"
            >
              Browse Accessories
            </Link>
          </div>

          {/* Trust Badges */}
          <div className="mt-12 flex flex-wrap justify-center gap-6 md:gap-10">
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">500+</div>
              <div className="font-doodle text-sm text-doodle-text/60">Products</div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">Free</div>
              <div className="font-doodle text-sm text-doodle-text/60">Shipping $50+</div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">30-Day</div>
              <div className="font-doodle text-sm text-doodle-text/60">Returns</div>
            </div>
            <div className="text-center">
              <div className="font-doodle text-2xl md:text-3xl font-bold text-doodle-green">24/7</div>
              <div className="font-doodle text-sm text-doodle-text/60">Support</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default HeroSection;
