import React from "react";
import { Monitor, Building2, Layers } from "lucide-react";
import type { SalesChannel } from "@/hooks/useReportingData";

interface ChannelSelectorProps {
  channel: SalesChannel;
  onChange: (channel: SalesChannel) => void;
  /** Show combined "All" option (default: true) */
  showAll?: boolean;
  className?: string;
}

const CHANNELS: { value: SalesChannel; label: string; icon: React.ElementType; colour: string }[] = [
  {
    value: "all",
    label: "Combined",
    icon: Layers,
    colour: "text-doodle-accent border-doodle-accent bg-doodle-accent/10",
  },
  {
    value: "eshop",
    label: "eShop",
    icon: Monitor,
    colour: "text-doodle-blue border-doodle-blue bg-doodle-blue/10",
  },
  {
    value: "b2b",
    label: "B2B",
    icon: Building2,
    colour: "text-doodle-green border-doodle-green bg-doodle-green/10",
  },
];

const INACTIVE =
  "text-doodle-text/50 border-doodle-text/20 bg-transparent hover:border-doodle-text/40";

const ChannelSelector: React.FC<ChannelSelectorProps> = ({
  channel,
  onChange,
  showAll = true,
  className = "",
}) => {
  const options = showAll ? CHANNELS : CHANNELS.filter((c) => c.value !== "all");

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <span className="font-doodle text-xs text-doodle-text/50 mr-1 uppercase tracking-wide whitespace-nowrap">
        Channel:
      </span>
      {options.map(({ value, label, icon: Icon, colour }) => (
        <button
          key={value}
          onClick={() => onChange(value)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 border-2 rounded font-doodle text-sm font-medium transition-colors ${
            channel === value ? colour : INACTIVE
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
};

export default ChannelSelector;
export type { ChannelSelectorProps };
