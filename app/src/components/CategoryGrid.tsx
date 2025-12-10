import React from 'react';
import { Link } from 'react-router-dom';
import { Bike, Cog, Shirt, Backpack, ArrowRight } from 'lucide-react';
import { useCategories } from '@/hooks/useProducts';

const iconMap: Record<string, React.ElementType> = {
  bike: Bike,
  cog: Cog,
  shirt: Shirt,
  backpack: Backpack,
};

const CategoryGrid: React.FC = () => {
  const { data: categories = [], isLoading } = useCategories();

  if (isLoading) {
    return (
      <section className="py-12">
        <div className="container mx-auto px-4">
          <div className="h-10 w-64 bg-doodle-text/10 rounded mx-auto mb-2 animate-pulse"></div>
          <div className="h-4 w-96 bg-doodle-text/10 rounded mx-auto mb-8 animate-pulse"></div>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="doodle-card p-6 animate-pulse">
                <div className="w-16 h-16 mx-auto mb-4 bg-doodle-text/10 rounded"></div>
                <div className="h-6 bg-doodle-text/10 rounded mb-3 mx-auto w-3/4"></div>
                <div className="h-4 bg-doodle-text/10 rounded mx-auto w-1/2"></div>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-12">
      <div className="container mx-auto px-4">
        <h2 className="font-doodle text-3xl md:text-4xl font-bold text-center mb-2 text-doodle-text">
          Shop by Category
        </h2>
        <p className="font-doodle text-center text-doodle-text/70 mb-8">
          Find exactly what you need for your next adventure
        </p>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
          {categories.map((category, index) => {
            const IconComponent = iconMap[category.IconName || 'bike'] || Bike;
            
            return (
              <Link
                key={category.ProductCategoryID}
                to={`/category/${category.ProductCategoryID}`}
                className="doodle-card p-6 text-center group"
                style={{ animationDelay: `${index * 100}ms` }}
              >
                <div className="w-16 h-16 mx-auto mb-4 doodle-border-light flex items-center justify-center group-hover:rotate-6 transition-transform">
                  <IconComponent className="w-8 h-8 text-doodle-text group-hover:text-doodle-accent transition-colors" />
                </div>
                
                <h3 className="font-doodle text-lg md:text-xl font-bold text-doodle-text group-hover:text-doodle-accent transition-colors">
                  {category.Name}
                </h3>
                
                <div className="mt-3 flex items-center justify-center gap-1 text-doodle-accent opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="font-doodle text-sm">Browse</span>
                  <ArrowRight className="w-4 h-4" />
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default CategoryGrid;
