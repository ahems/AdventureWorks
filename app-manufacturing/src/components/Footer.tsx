import React from 'react';
import { Link } from 'react-router-dom';
import { Bike } from 'lucide-react';

const Footer: React.FC = () => {
  return (
    <footer className="bg-doodle-text text-doodle-bg mt-16">
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2">
              <div className="bg-doodle-bg p-1.5 border-2 border-doodle-bg">
                <Bike className="w-5 h-5 text-doodle-text" />
              </div>
              <span className="font-doodle text-lg font-bold">
                Adventure<span className="text-doodle-accent">Works</span>
                <span className="text-xs ml-2 opacity-60">Production Hub</span>
              </span>
            </Link>
          </div>

          <div className="flex items-center gap-4 text-right">
            <span className="font-doodle text-xs opacity-50">v1.0.0</span>
            <span className="font-doodle text-sm opacity-60">© {new Date().getFullYear()} Adventure Works</span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
