import React from 'react';

const AdminProductCardSkeleton: React.FC = () => {
  return (
    <div className="doodle-card overflow-hidden animate-pulse">
      {/* Product Image */}
      <div className="aspect-square bg-doodle-text/10" />
      
      {/* Product Info */}
      <div className="p-4 space-y-3">
        {/* SKU */}
        <div className="h-3 bg-doodle-text/10 rounded w-20" />
        
        {/* Name */}
        <div className="h-5 bg-doodle-text/10 rounded w-3/4" />
        
        {/* Rating */}
        <div className="h-3 bg-doodle-text/10 rounded w-24" />
        
        {/* Price */}
        <div className="h-6 bg-doodle-text/10 rounded w-20" />
        
        {/* Details */}
        <div className="pt-3 border-t-2 border-dashed border-doodle-text/10 space-y-2">
          <div className="h-3 bg-doodle-text/10 rounded w-2/3" />
          <div className="h-3 bg-doodle-text/10 rounded w-1/2" />
        </div>
      </div>
    </div>
  );
};

export default AdminProductCardSkeleton;
