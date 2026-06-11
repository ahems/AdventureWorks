import React from 'react';

const countryToFlag: Record<string, string> = {
  'United States': '🇺🇸',
  'Germany': '🇩🇪',
  'France': '🇫🇷',
  'Japan': '🇯🇵',
  'Mexico': '🇲🇽',
  'United Kingdom': '🇬🇧',
  'Canada': '🇨🇦',
  'Italy': '🇮🇹',
  'Brazil': '🇧🇷',
  'Spain': '🇪🇸',
  'Australia': '🇦🇺',
  'Netherlands': '🇳🇱',
  'Sweden': '🇸🇪',
  'Switzerland': '🇨🇭',
  'Austria': '🇦🇹',
  'Belgium': '🇧🇪',
  'Norway': '🇳🇴',
  'Denmark': '🇩🇰',
  'Poland': '🇵🇱',
  'Portugal': '🇵🇹',
  'Ireland': '🇮🇪',
  'South Korea': '🇰🇷',
  'China': '🇨🇳',
  'India': '🇮🇳',
  'Argentina': '🇦🇷',
  'Chile': '🇨🇱',
  'Colombia': '🇨🇴',
  'New Zealand': '🇳🇿',
  'South Africa': '🇿🇦',
  'Singapore': '🇸🇬',
};

interface CountryFlagProps {
  country: string;
  className?: string;
}

const CountryFlag: React.FC<CountryFlagProps> = ({ country, className = '' }) => {
  const flag = countryToFlag[country] || '🌍';
  
  return (
    <span className={className} role="img" aria-label={`${country} flag`}>
      {flag}
    </span>
  );
};

export default CountryFlag;
