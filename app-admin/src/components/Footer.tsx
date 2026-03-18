import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Bike,
  HelpCircle,
  Shield,
  FileText,
  Database,
  Server,
  Wifi,
} from "lucide-react";
import { getFunctionsApiUrl, getGraphQLApiUrl } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface SystemStatus {
  database: "healthy" | "degraded" | "down";
  api: "healthy" | "degraded" | "down";
  services: "healthy" | "degraded" | "down";
}

const Footer: React.FC = () => {
  const [status, setStatus] = useState<SystemStatus>({
    database: "healthy",
    api: "healthy",
    services: "healthy",
  });

  const worse = (
    a: "healthy" | "degraded" | "down",
    b: "healthy" | "degraded" | "down",
  ): "healthy" | "degraded" | "down" => {
    if (a === "down" || b === "down") return "down";
    if (a === "degraded" || b === "degraded") return "degraded";
    return "healthy";
  };

  const checkHealth = useCallback(async () => {
    let apiStatus: "healthy" | "degraded" | "down" = "down";
    let dbStatus: "healthy" | "degraded" | "down" = "down";

    await Promise.allSettled([
      (async () => {
        try {
          const res = await fetch(`${getFunctionsApiUrl()}/api/health`, {
            signal: AbortSignal.timeout(5000),
          });
          apiStatus = res.ok ? "healthy" : "degraded";
        } catch {
          apiStatus = "down";
        }
      })(),
      (async () => {
        try {
          const res = await fetch(getGraphQLApiUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "{ products(first: 1) { items { ProductID } } }",
            }),
            signal: AbortSignal.timeout(5000),
          });
          const json = await res.json();
          dbStatus = json?.data?.products ? "healthy" : "degraded";
        } catch {
          dbStatus = "down";
        }
      })(),
    ]);

    setStatus({
      database: dbStatus,
      api: apiStatus,
      services: worse(apiStatus, dbStatus),
    });
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const getOverallStatus = () => {
    const statuses = Object.values(status);
    if (statuses.includes("down")) return "down";
    if (statuses.includes("degraded")) return "degraded";
    return "healthy";
  };

  const getStatusColor = (s: "healthy" | "degraded" | "down") => {
    switch (s) {
      case "healthy":
        return "bg-doodle-green";
      case "degraded":
        return "bg-yellow-500";
      case "down":
        return "bg-doodle-accent";
    }
  };

  const getStatusText = (s: "healthy" | "degraded" | "down") => {
    switch (s) {
      case "healthy":
        return "Operational";
      case "degraded":
        return "Degraded";
      case "down":
        return "Down";
    }
  };

  const overallStatus = getOverallStatus();

  return (
    <footer className="bg-doodle-text text-doodle-bg mt-16">
      <div className="container mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <Link to="/" className="flex items-center gap-2">
              <div className="bg-doodle-bg p-1.5 border-2 border-doodle-bg">
                <Bike className="w-5 h-5 text-doodle-text" />
              </div>
              <span className="font-doodle text-lg font-bold">
                Adventure<span className="text-doodle-accent">Works</span>
                <span className="text-xs ml-2 opacity-60">Admin Portal</span>
              </span>
            </Link>
          </div>

          {/* System Status */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-doodle-bg/10 border border-doodle-bg/20 cursor-pointer hover:bg-doodle-bg/20 transition-colors">
                <div
                  className={`w-2 h-2 rounded-full ${getStatusColor(overallStatus)} animate-pulse`}
                />
                <span className="font-doodle text-xs">
                  Systems: {getStatusText(overallStatus)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="p-3">
              <div className="space-y-2">
                <p className="font-doodle text-xs font-bold border-b pb-1 mb-2">
                  System Status
                </p>
                <div className="flex items-center gap-2">
                  <Database className="w-3 h-3" />
                  <span className="font-doodle text-xs flex-1">Database</span>
                  <div
                    className={`w-2 h-2 rounded-full ${getStatusColor(status.database)}`}
                  />
                  <span className="font-doodle text-xs opacity-70">
                    {getStatusText(status.database)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Server className="w-3 h-3" />
                  <span className="font-doodle text-xs flex-1">API Server</span>
                  <div
                    className={`w-2 h-2 rounded-full ${getStatusColor(status.api)}`}
                  />
                  <span className="font-doodle text-xs opacity-70">
                    {getStatusText(status.api)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Wifi className="w-3 h-3" />
                  <span className="font-doodle text-xs flex-1">Services</span>
                  <div
                    className={`w-2 h-2 rounded-full ${getStatusColor(status.services)}`}
                  />
                  <span className="font-doodle text-xs opacity-70">
                    {getStatusText(status.services)}
                  </span>
                </div>
                <p className="font-doodle text-[10px] opacity-50 pt-1 border-t">
                  Live status · refreshes every 30s
                </p>
              </div>
            </TooltipContent>
          </Tooltip>

          {/* Admin Links */}
          <div className="flex items-center gap-6">
            <Link
              to="#"
              className="flex items-center gap-1.5 font-doodle text-sm opacity-70 hover:opacity-100 hover:text-doodle-accent transition-colors"
            >
              <HelpCircle className="w-4 h-4" />
              Help Center
            </Link>
            <Link
              to="#"
              className="flex items-center gap-1.5 font-doodle text-sm opacity-70 hover:opacity-100 hover:text-doodle-accent transition-colors"
            >
              <FileText className="w-4 h-4" />
              Documentation
            </Link>
            <Link
              to="#"
              className="flex items-center gap-1.5 font-doodle text-sm opacity-70 hover:opacity-100 hover:text-doodle-accent transition-colors"
            >
              <Shield className="w-4 h-4" />
              Privacy Policy
            </Link>
          </div>

          {/* Version & Copyright */}
          <div className="flex items-center gap-4 text-right">
            <span className="font-doodle text-xs opacity-50">v1.0.0</span>
            <span className="font-doodle text-sm opacity-60">
              © 2024 Adventure Works
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
