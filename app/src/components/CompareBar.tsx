import React from 'react';
import { Link } from 'react-router-dom';
import { X, ArrowRight, Scale } from 'lucide-react';
import { useCompare } from '@/context/CompareContext';

const CompareBar: React.FC = () => {
  const { items, removeFromCompare, clearCompare } = useCompare();

  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-doodle-bg border-t-4 border-doodle-text shadow-lg">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Scale className="w-5 h-5 text-doodle-accent" />
            <span className="font-doodle font-bold text-doodle-text">
              Compare ({items.length}/3)
            </span>
          </div>

          <div className="flex items-center gap-3 flex-1 justify-center overflow-x-auto">
            {items.map((product) => (
              <div
                key={product.ProductID}
                className="flex items-center gap-2 bg-doodle-text/5 border-2 border-dashed border-doodle-text/20 px-3 py-2"
              >
                <span className="font-doodle text-sm text-doodle-text truncate max-w-[120px]">
                  {product.Name}
                </span>
                <button
                  onClick={() => removeFromCompare(product.ProductID)}
                  className="p-1 hover:bg-doodle-accent/10 rounded transition-colors"
                  aria-label={`Remove ${product.Name} from comparison`}
                >
                  <X className="w-4 h-4 text-doodle-accent" />
                </button>
              </div>
            ))}
            
            {/* Empty slots */}
            {Array.from({ length: 3 - items.length }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="flex items-center gap-2 border-2 border-dashed border-doodle-text/10 px-3 py-2"
              >
                <span className="font-doodle text-sm text-doodle-text/30">
                  Add product
                </span>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={clearCompare}
              className="font-doodle text-sm text-doodle-text/70 hover:text-doodle-accent transition-colors"
            >
              Clear all
            </button>
            <Link
              to="/compare"
              className="doodle-button doodle-button-primary flex items-center gap-2"
            >
              Compare
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompareBar;
