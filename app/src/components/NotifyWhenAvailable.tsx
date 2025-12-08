import React, { useState } from 'react';
import { Bell, X, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/hooks/use-toast';

interface NotifyWhenAvailableProps {
  productName: string;
  size?: string;
  color?: string;
  trigger: React.ReactNode;
}

const NotifyWhenAvailable: React.FC<NotifyWhenAvailableProps> = ({
  productName,
  size,
  color,
  trigger,
}) => {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!email || !email.includes('@')) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address",
        variant: "destructive"
      });
      return;
    }

    setIsSubmitting(true);
    
    // Simulate API call - in production this would save to a database
    await new Promise(resolve => setTimeout(resolve, 800));
    
    // Store in localStorage as a demo (in production, use backend)
    const notifications = JSON.parse(localStorage.getItem('stockNotifications') || '[]');
    notifications.push({
      email,
      productName,
      size,
      color,
      createdAt: new Date().toISOString()
    });
    localStorage.setItem('stockNotifications', JSON.stringify(notifications));
    
    setIsSubmitting(false);
    setIsSuccess(true);
    
    toast({
      title: "You're on the list!",
      description: "We'll email you when this item is back in stock",
    });
    
    // Reset and close after a moment
    setTimeout(() => {
      setOpen(false);
      setIsSuccess(false);
      setEmail('');
    }, 1500);
  };

  const variantText = [size, color].filter(Boolean).join(' / ');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div onClick={() => setOpen(true)}>
        {trigger}
      </div>
      <DialogContent className="bg-white border-2 border-doodle-text max-w-md">
        <DialogHeader>
          <DialogTitle className="font-doodle text-xl text-doodle-text flex items-center gap-2">
            <Bell className="w-5 h-5 text-doodle-accent" />
            Get Notified
          </DialogTitle>
          <DialogDescription className="font-doodle text-doodle-text/70">
            We'll send you an email when this item is back in stock.
          </DialogDescription>
        </DialogHeader>

        {isSuccess ? (
          <div className="py-8 text-center">
            <div className="w-16 h-16 bg-doodle-green/10 border-2 border-doodle-green rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-doodle-green" />
            </div>
            <p className="font-doodle text-lg font-bold text-doodle-text">You're all set!</p>
            <p className="font-doodle text-sm text-doodle-text/70 mt-1">
              We'll notify you when it's available.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Product Info */}
            <div className="bg-doodle-bg border-2 border-dashed border-doodle-text/30 p-3">
              <p className="font-doodle font-bold text-doodle-text">{productName}</p>
              {variantText && (
                <p className="font-doodle text-sm text-doodle-text/70">{variantText}</p>
              )}
            </div>

            {/* Email Input */}
            <div className="space-y-2">
              <label htmlFor="notify-email" className="font-doodle text-sm font-bold text-doodle-text">
                Email Address
              </label>
              <Input
                id="notify-email"
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="font-doodle border-2 border-doodle-text/50 focus:border-doodle-accent"
                required
              />
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full doodle-button doodle-button-primary flex items-center justify-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="animate-spin">⏳</span>
                  Submitting...
                </>
              ) : (
                <>
                  <Bell className="w-4 h-4" />
                  Notify Me
                </>
              )}
            </button>

            <p className="font-doodle text-xs text-doodle-text/50 text-center">
              We'll only use your email to notify you about this product.
            </p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default NotifyWhenAvailable;
