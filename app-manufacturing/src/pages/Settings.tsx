import React from "react";
import { Link } from "react-router-dom";
import { Settings, Warehouse, Bot } from "lucide-react";
import SimulationControlCard from "@/components/settings/SimulationControlCard";
import VendorRestockCard from "@/components/settings/VendorRestockCard";
import ScrapConfigPanel from "@/components/settings/ScrapConfigPanel";
import LocationConfigPanel from "@/components/settings/LocationConfigPanel";
import SupplyChainTimingCard from "@/components/settings/SupplyChainTimingCard";
import { AgentQueueCard } from "@/components/settings/AgentQueueCard";

const SettingsPage: React.FC = () => {
  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <Settings className="h-7 w-7 text-primary" /> Settings &amp; Simulator
          Controls
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          Behind-the-scenes controls for the Production Hub demo environment.
          These actions affect the underlying simulation rather than day-to-day
          production work — use with care.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">
          Simulation Control
        </h2>
        <SimulationControlCard />
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">
          Vendor Operations
        </h2>
        <SupplyChainTimingCard />
        <VendorRestockCard />
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">
          Shop-Floor Tuning
        </h2>
        <ScrapConfigPanel />
        <LocationConfigPanel />
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">Warehouse</h2>
        <p className="text-sm text-muted-foreground">
          The warehouse is always-on and event-driven — it processes work
          automatically as manufacturing completes products, orders are
          approved, and supplier deliveries arrive. Use the link below to tune
          timing defaults and damage rates.
        </p>
        <Link
          to="/warehouse/config"
          className="inline-flex items-center gap-2 doodle-button px-4 py-2 text-sm rounded"
        >
          <Warehouse className="h-4 w-4" /> Warehouse Configuration
        </Link>
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text flex items-center gap-2">
          <Bot className="h-5 w-5" /> AI Manufacturing Agent
        </h2>
        <p className="text-sm text-muted-foreground">
          The AI agent analyses each new order for inventory and manufacturing
          impact. Use the controls below to drain the order queue or clear
          permanently-failed items. To change the agent's autonomy mode, use the
          Agent Control page.
        </p>
        <AgentQueueCard />
      </section>
    </div>
  );
};

export default SettingsPage;
