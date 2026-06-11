import React from 'react';
import { Settings } from 'lucide-react';
import SimulationControlCard from '@/components/settings/SimulationControlCard';
import VendorRestockCard from '@/components/settings/VendorRestockCard';
import ScrapConfigPanel from '@/components/settings/ScrapConfigPanel';
import LocationConfigPanel from '@/components/settings/LocationConfigPanel';

const SettingsPage: React.FC = () => {
  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold font-doodle flex items-center gap-2">
          <Settings className="h-7 w-7 text-primary" /> Settings &amp; Simulator Controls
        </h1>
        <p className="text-muted-foreground text-sm mt-1 max-w-3xl">
          Behind-the-scenes controls for the Production Hub demo environment. These actions affect the underlying
          simulation rather than day-to-day production work — use with care.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">Simulation Control</h2>
        <SimulationControlCard />
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">Vendor Operations</h2>
        <VendorRestockCard />
      </section>

      <section className="space-y-3">
        <h2 className="font-doodle text-lg text-doodle-text">Shop-Floor Tuning</h2>
        <ScrapConfigPanel />
        <LocationConfigPanel />
      </section>
    </div>
  );
};

export default SettingsPage;
