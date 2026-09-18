import React from "react";

interface AdminLogoProps {
  className?: string;
}

const AdminLogo: React.FC<AdminLogoProps> = ({ className = "w-6 h-6" }) => (
  <svg
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <defs>
      <linearGradient id="admin-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="#8b5cf6" />
        <stop offset="100%" stopColor="#6d28d9" />
      </linearGradient>
    </defs>
    <rect width="100" height="100" rx="16" fill="url(#admin-gradient)" />
    {/* Shield shape */}
    <path
      d="M50 18 L75 30 C75 55 67 72 50 82 C33 72 25 55 25 30 Z"
      fill="white"
      opacity="0.95"
    />
    {/* Inner shield accent */}
    <path
      d="M50 26 L69 35 C69 54 63 67 50 75 C37 67 31 54 31 35 Z"
      fill="url(#admin-gradient)"
      opacity="0.3"
    />
    {/* Star/admin badge */}
    <path
      d="M50 38 L53 47 L62 47 L55 53 L57 62 L50 57 L43 62 L45 53 L38 47 L47 47 Z"
      fill="white"
    />
  </svg>
);

export default AdminLogo;
