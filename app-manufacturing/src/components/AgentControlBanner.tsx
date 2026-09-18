import { Link } from "react-router-dom";
import { Bot, ArrowRight } from "lucide-react";
import { useManufacturingAgentMode } from "@/hooks/useManufacturingAgentMode";

/**
 * Shown on pages where the AI agent is actively controlling decisions.
 * Disables manual actions and directs the user to /manufacturing-agent
 * to switch back to Read-Only mode.
 */
const AgentControlBanner: React.FC = () => {
  const { isAgentActive, modeLabel } = useManufacturingAgentMode();

  if (!isAgentActive) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 mb-4 rounded-lg border border-doodle-blue/40 bg-doodle-blue/10 text-sm">
      <Bot className="h-4 w-4 shrink-0 text-doodle-blue" />
      <span className="flex-1 text-doodle-text">
        The AI agent is managing production and supply chain decisions
        <span className="ml-1 font-medium text-doodle-blue">({modeLabel})</span>
        . Manual create actions are disabled.
      </span>
      <Link
        to="/manufacturing-agent"
        className="flex items-center gap-1 text-doodle-blue hover:underline font-medium whitespace-nowrap"
      >
        Disable on Agent Control <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
};

export default AgentControlBanner;
