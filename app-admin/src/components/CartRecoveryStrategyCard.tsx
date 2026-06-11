import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Mail, Eye, Clock, DollarSign, ShoppingCart, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface CartStrategy {
  cart: {
    ShoppingCartID: string;
    customerEmail: string;
    customerName: string;
    totalItems: number;
    totalValue: number;
    daysStale: number;
  };
  recoveryScore: number;
  urgency: 'high' | 'medium' | 'low';
  strategy: string;
  recommendedDiscount: number;
  emailSubject: string;
  emailPreview: string;
}

interface CartRecoveryStrategyCardProps {
  strategy: CartStrategy;
}

const CartRecoveryStrategyCard: React.FC<CartRecoveryStrategyCardProps> = ({ strategy }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const { cart, recoveryScore, urgency, recommendedDiscount, emailSubject, emailPreview } = strategy;

  const handleSendEmail = () => {
    setEmailSent(true);
    toast.success(`Recovery email sent to ${cart.customerEmail}`, {
      description: `Subject: ${emailSubject}`
    });
  };

  const getUrgencyStyles = () => {
    switch (urgency) {
      case 'high':
        return {
          badge: 'bg-green-100 text-green-700 border-green-300',
          border: 'border-l-green-500',
          scoreColor: 'text-green-600'
        };
      case 'medium':
        return {
          badge: 'bg-yellow-100 text-yellow-700 border-yellow-300',
          border: 'border-l-yellow-500',
          scoreColor: 'text-yellow-600'
        };
      case 'low':
        return {
          badge: 'bg-red-100 text-red-700 border-red-300',
          border: 'border-l-red-500',
          scoreColor: 'text-red-600'
        };
    }
  };

  const styles = getUrgencyStyles();

  return (
    <div className={`border-2 border-doodle-text/20 rounded-lg overflow-hidden border-l-4 ${styles.border}`}>
      {/* Header */}
      <div 
        className="p-4 cursor-pointer hover:bg-doodle-text/5 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Recovery Score Circle */}
            <div className="relative w-14 h-14">
              <svg className="w-14 h-14 transform -rotate-90">
                <circle
                  cx="28"
                  cy="28"
                  r="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  className="text-doodle-text/10"
                />
                <circle
                  cx="28"
                  cy="28"
                  r="24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeDasharray={`${(recoveryScore / 100) * 151} 151`}
                  className={styles.scoreColor}
                />
              </svg>
              <span className={`absolute inset-0 flex items-center justify-center font-doodle font-bold text-sm ${styles.scoreColor}`}>
                {recoveryScore}%
              </span>
            </div>

            {/* Cart Info */}
            <div>
              <div className="flex items-center gap-2">
                <span className="font-doodle font-bold text-doodle-text">{cart.customerName}</span>
                <Badge className={`${styles.badge} border font-doodle text-xs`}>
                  {urgency.toUpperCase()} PRIORITY
                </Badge>
                {emailSent && (
                  <Badge className="bg-green-100 text-green-700 border-green-300 border font-doodle text-xs">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    EMAIL SENT
                  </Badge>
                )}
              </div>
              <p className="font-doodle text-sm text-doodle-text/60">{cart.customerEmail}</p>
              <div className="flex items-center gap-4 mt-1 text-sm text-doodle-text/50">
                <span className="flex items-center gap-1">
                  <ShoppingCart className="w-3 h-3" />
                  {cart.totalItems} items
                </span>
                <span className="flex items-center gap-1">
                  <DollarSign className="w-3 h-3" />
                  ${cart.totalValue.toFixed(2)}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {cart.daysStale} days stale
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {recommendedDiscount > 0 && (
              <span className="font-doodle text-sm bg-doodle-accent/10 text-doodle-accent px-2 py-1 rounded">
                {recommendedDiscount}% off recommended
              </span>
            )}
            {isExpanded ? (
              <ChevronUp className="w-5 h-5 text-doodle-text/50" />
            ) : (
              <ChevronDown className="w-5 h-5 text-doodle-text/50" />
            )}
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t-2 border-dashed border-doodle-text/20 p-4 bg-doodle-text/5">
          {/* Strategy */}
          <div className="mb-4">
            <p className="font-doodle text-xs text-doodle-text/50 uppercase mb-1">AI Strategy</p>
            <p className="font-doodle text-sm text-doodle-text">{strategy.strategy}</p>
          </div>

          {/* Email Preview */}
          <div className="mb-4">
            <p className="font-doodle text-xs text-doodle-text/50 uppercase mb-1">Email Preview</p>
            <div className="bg-white dark:bg-black/20 border-2 border-doodle-text/20 rounded-lg p-4">
              <p className="font-doodle text-sm font-bold text-doodle-text mb-2">
                Subject: {emailSubject}
              </p>
              <p className="font-doodle text-sm text-doodle-text/80 whitespace-pre-wrap">
                {emailPreview}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleSendEmail}
              disabled={emailSent}
              className="doodle-button doodle-button-primary"
            >
              {emailSent ? (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Sent
                </>
              ) : (
                <>
                  <Mail className="w-4 h-4 mr-2" />
                  Send Recovery Email
                </>
              )}
            </Button>
            <Button variant="outline" className="doodle-button">
              <Eye className="w-4 h-4 mr-2" />
              View Full Cart
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CartRecoveryStrategyCard;
