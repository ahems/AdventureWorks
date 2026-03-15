import React, { useState } from 'react';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import UtilityStatusPanel from './UtilityStatusPanel';

interface UtilityFunctionCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  warningBadge?: string;
  infoBadge?: string;
  children?: React.ReactNode;
  onExecute: () => Promise<{ id: string }>;
  actionLabel?: string;
}

const UtilityFunctionCard: React.FC<UtilityFunctionCardProps> = ({
  title,
  description,
  icon,
  warningBadge,
  infoBadge,
  children,
  onExecute,
  actionLabel = 'Execute',
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [inputsOpen, setInputsOpen] = useState(true);

  const handleExecute = async () => {
    setIsLoading(true);
    setInstanceId(null);
    try {
      const response = await onExecute();
      setInstanceId(response.id);
    } catch (error) {
      console.error('Execution failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleComplete = () => {
    // Optionally reset state or show completion message
  };

  return (
    <div className="doodle-card p-5 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="p-2 bg-primary/10 rounded-lg text-primary">
          {icon}
        </div>
        <div className="flex-1">
          <h3 className="font-doodle font-bold text-lg text-foreground">{title}</h3>
          <p className="text-sm text-muted-foreground font-doodle mt-1">{description}</p>
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-2 mb-4">
        {warningBadge && (
          <Badge variant="destructive" className="flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            {warningBadge}
          </Badge>
        )}
        {infoBadge && (
          <Badge variant="secondary" className="flex items-center gap-1">
            <Info className="w-3 h-3" />
            {infoBadge}
          </Badge>
        )}
      </div>

      {/* Collapsible Inputs */}
      {children && (
        <Collapsible open={inputsOpen} onOpenChange={setInputsOpen} className="mb-4">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between mb-2">
              <span className="font-doodle text-sm">Options</span>
              <ChevronDown className={`w-4 h-4 transition-transform ${inputsOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="p-3 bg-muted/30 rounded-lg">
            {children}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Action Button */}
      <Button
        onClick={handleExecute}
        disabled={isLoading}
        className="w-full doodle-button-primary"
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Starting...
          </>
        ) : (
          actionLabel
        )}
      </Button>

      {/* Status Panel */}
      {instanceId && (
        <UtilityStatusPanel instanceId={instanceId} onComplete={handleComplete} />
      )}
    </div>
  );
};

export default UtilityFunctionCard;
