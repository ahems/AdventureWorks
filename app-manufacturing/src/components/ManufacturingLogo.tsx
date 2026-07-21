import React from "react";

interface ManufacturingLogoProps {
  className?: string;
}

const ManufacturingLogo: React.FC<ManufacturingLogoProps> = ({
  className = "w-6 h-6",
}) => (
  <svg
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <defs>
      <linearGradient id="gear-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#3b82f6" />
        <stop offset="100%" stopColor="#1d4ed8" />
      </linearGradient>
    </defs>
    <rect width="100" height="100" rx="16" fill="url(#gear-gradient)" />
    <g transform="translate(50,50)" fill="white">
      <path d="M-5,-34 L5,-34 L6,-28 Q9,-27 12,-25 L17,-29 L24,-22 L20,-17 Q22,-14 23,-11 L29,-10 L29,0 L23,-1 Q22,2 20,5 L24,10 L17,17 L13,12 Q10,14 7,15 L6,22 L-6,22 L-7,15 Q-10,14 -13,12 L-17,17 L-24,10 L-20,5 Q-22,2 -23,-1 L-29,0 L-29,-10 L-23,-11 Q-22,-14 -20,-17 L-24,-22 L-17,-29 L-12,-25 Q-9,-27 -6,-28 Z" />
      <circle r="9" fill="#2563eb" />
    </g>
  </svg>
);

export default ManufacturingLogo;
