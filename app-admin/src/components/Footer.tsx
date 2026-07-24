import React from "react";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import AdminLogo from "@/components/AdminLogo";
import { getAppUrl, getManufacturingUrl } from "@/lib/utils";

const Footer: React.FC = () => {
  const appUrl = getAppUrl() || "/";
  const manufacturingUrl = getManufacturingUrl();

  return (
    <footer className="bg-doodle-text text-doodle-bg mt-16">
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2">
              <div>
                <AdminLogo className="w-7 h-7" />
              </div>
              <span className="font-doodle text-lg font-bold">
                Adventure<span className="text-doodle-accent">Works</span>
                <span className="text-xs ml-2 opacity-60">Admin Portal</span>
              </span>
            </Link>
          </div>

          {/* Portal Links */}
          <div className="flex items-center gap-4">
            <a
              href={appUrl}
              className="flex items-center gap-1.5 font-doodle text-sm opacity-70 hover:opacity-100 hover:text-doodle-accent transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Customer Store
            </a>
            {manufacturingUrl && (
              <a
                href={manufacturingUrl}
                className="flex items-center gap-1.5 font-doodle text-sm opacity-70 hover:opacity-100 hover:text-doodle-accent transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Manufacturing Portal
              </a>
            )}
          </div>

          {/* Copyright */}
          <div className="flex items-center text-right">
            <span className="font-doodle text-sm opacity-60">
              © {new Date().getFullYear()} Adventure Works
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
