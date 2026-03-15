import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Mail, Send, Loader2 } from 'lucide-react';
import { ReceiptData } from '@/services/mockReceiptService';

interface EmailReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receiptData: ReceiptData | null;
  onSend: (email: string, subject: string, message: string) => Promise<void>;
}

const EmailReceiptDialog: React.FC<EmailReceiptDialogProps> = ({
  open,
  onOpenChange,
  receiptData,
  onSend,
}) => {
  const [email, setEmail] = useState(receiptData?.customerEmail || '');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Update defaults when receiptData changes
  React.useEffect(() => {
    if (receiptData) {
      setEmail(receiptData.customerEmail);
      setSubject(`Your Order Receipt - ${receiptData.orderNumber}`);
      setMessage(
        `Dear ${receiptData.customerName},\n\nPlease find attached your receipt for order ${receiptData.orderNumber} placed on ${receiptData.orderDate}.\n\nOrder Total: $${receiptData.total.toFixed(2)}\n\nThank you for shopping with AdventureWorks!\n\nBest regards,\nThe AdventureWorks Team`
      );
    }
  }, [receiptData]);

  const handleSend = async () => {
    if (!email || !subject) return;
    
    setIsSending(true);
    try {
      await onSend(email, subject, message);
      onOpenChange(false);
    } finally {
      setIsSending(false);
    }
  };

  if (!receiptData) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-doodle flex items-center gap-2">
            <Mail className="w-5 h-5" />
            Email Receipt - {receiptData.orderNumber}
          </DialogTitle>
          <DialogDescription className="font-doodle">
            Send a copy of the receipt directly to the customer's email.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="font-doodle">
              Recipient Email
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="customer@example.com"
              className="font-doodle"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject" className="font-doodle">
              Subject
            </Label>
            <Input
              id="subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Order Receipt"
              className="font-doodle"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="message" className="font-doodle">
              Message
            </Label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a personal message..."
              className="font-doodle min-h-[150px]"
            />
          </div>

          {/* Attachment Preview */}
          <div className="p-3 bg-doodle-text/5 border-2 border-dashed border-doodle-text/20 rounded">
            <p className="font-doodle text-sm text-doodle-text/70 flex items-center gap-2">
              <span className="text-lg">📎</span>
              <span>
                <strong>Attachment:</strong> Receipt-{receiptData.orderNumber}.pdf
              </span>
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="font-doodle"
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={isSending || !email || !subject}
            className="font-doodle"
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Send Email
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmailReceiptDialog;
