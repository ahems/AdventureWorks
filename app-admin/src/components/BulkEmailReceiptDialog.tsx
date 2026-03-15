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
import { Mail, Send, Loader2, CheckCircle2, XCircle, Users } from 'lucide-react';
import { Order, getCustomerById } from '@/data/mockCustomers';
import { generateReceiptData } from '@/services/mockReceiptService';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';

interface BulkEmailReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedOrders: Order[];
  onComplete: () => void;
}

interface EmailStatus {
  orderId: number;
  email: string;
  status: 'pending' | 'sending' | 'success' | 'failed';
  error?: string;
}

const BulkEmailReceiptDialog: React.FC<BulkEmailReceiptDialogProps> = ({
  open,
  onOpenChange,
  selectedOrders,
  onComplete,
}) => {
  const [subject, setSubject] = useState('Your Order Receipt from AdventureWorks');
  const [message, setMessage] = useState(
    `Dear Customer,\n\nPlease find attached your order receipt.\n\nThank you for shopping with AdventureWorks!\n\nBest regards,\nThe AdventureWorks Team`
  );
  const [isSending, setIsSending] = useState(false);
  const [emailStatuses, setEmailStatuses] = useState<EmailStatus[]>([]);
  const [sendingComplete, setSendingComplete] = useState(false);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setIsSending(false);
      setSendingComplete(false);
      setEmailStatuses(
        selectedOrders.map((order) => {
          const customer = getCustomerById(order.CustomerID);
          return {
            orderId: order.SalesOrderID,
            email: customer?.EmailAddress || 'unknown@example.com',
            status: 'pending' as const,
          };
        })
      );
    }
  }, [open, selectedOrders]);

  const progress = emailStatuses.length > 0
    ? (emailStatuses.filter((s) => s.status === 'success' || s.status === 'failed').length / emailStatuses.length) * 100
    : 0;

  const successCount = emailStatuses.filter((s) => s.status === 'success').length;
  const failedCount = emailStatuses.filter((s) => s.status === 'failed').length;

  const handleSendAll = async () => {
    if (!subject.trim()) return;
    
    setIsSending(true);

    for (let i = 0; i < selectedOrders.length; i++) {
      const order = selectedOrders[i];
      const receiptData = generateReceiptData(order);

      // Update status to sending
      setEmailStatuses((prev) =>
        prev.map((s) =>
          s.orderId === order.SalesOrderID ? { ...s, status: 'sending' as const } : s
        )
      );

      // Simulate sending delay
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));

      // 15% chance of failure for realism
      const failed = Math.random() < 0.15;

      setEmailStatuses((prev) =>
        prev.map((s) =>
          s.orderId === order.SalesOrderID
            ? {
                ...s,
                status: failed ? ('failed' as const) : ('success' as const),
                error: failed ? 'Connection timeout' : undefined,
              }
            : s
        )
      );
    }

    setIsSending(false);
    setSendingComplete(true);
  };

  const handleClose = () => {
    if (sendingComplete) {
      onComplete();
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-doodle flex items-center gap-2">
            <Users className="w-5 h-5" />
            Bulk Email Receipts ({selectedOrders.length} orders)
          </DialogTitle>
          <DialogDescription className="font-doodle">
            Send receipts to all selected customers at once.
          </DialogDescription>
        </DialogHeader>

        {!isSending && !sendingComplete ? (
          <>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="bulk-subject" className="font-doodle">
                  Email Subject
                </Label>
                <Input
                  id="bulk-subject"
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Order Receipt"
                  className="font-doodle"
                  maxLength={200}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bulk-message" className="font-doodle">
                  Message Template
                </Label>
                <Textarea
                  id="bulk-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Add a message..."
                  className="font-doodle min-h-[100px]"
                  maxLength={1000}
                />
              </div>

              {/* Recipients Preview */}
              <div className="space-y-2">
                <Label className="font-doodle">Recipients</Label>
                <ScrollArea className="h-[150px] border-2 border-doodle-text/20 rounded p-2">
                  <div className="space-y-1">
                    {selectedOrders.map((order) => {
                      const customer = getCustomerById(order.CustomerID);
                      const receiptData = generateReceiptData(order);
                      return (
                        <div
                          key={order.SalesOrderID}
                          className="flex justify-between items-center p-2 bg-doodle-text/5 rounded text-sm"
                        >
                          <div className="font-doodle">
                            <span className="font-bold">{receiptData.orderNumber}</span>
                            <span className="text-doodle-text/60 mx-2">•</span>
                            <span>{customer?.FirstName} {customer?.LastName}</span>
                          </div>
                          <span className="font-doodle text-doodle-text/60 text-xs">
                            {customer?.EmailAddress}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>
            </div>

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="font-doodle"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSendAll}
                disabled={!subject.trim()}
                className="font-doodle"
              >
                <Send className="w-4 h-4 mr-2" />
                Send {selectedOrders.length} Emails
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {/* Sending Progress */}
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-sm font-doodle">
                  <span>
                    {sendingComplete ? 'Sending Complete' : 'Sending emails...'}
                  </span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <Progress value={progress} className="h-2" />
              </div>

              {sendingComplete && (
                <div className="flex gap-4 justify-center p-3 bg-doodle-text/5 rounded">
                  <div className="flex items-center gap-2 font-doodle text-green-600">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{successCount} sent</span>
                  </div>
                  {failedCount > 0 && (
                    <div className="flex items-center gap-2 font-doodle text-red-600">
                      <XCircle className="w-4 h-4" />
                      <span>{failedCount} failed</span>
                    </div>
                  )}
                </div>
              )}

              <ScrollArea className="h-[200px] border-2 border-doodle-text/20 rounded p-2">
                <div className="space-y-1">
                  {emailStatuses.map((status) => (
                    <div
                      key={status.orderId}
                      className="flex justify-between items-center p-2 bg-doodle-text/5 rounded text-sm"
                    >
                      <div className="font-doodle flex items-center gap-2">
                        {status.status === 'pending' && (
                          <div className="w-4 h-4 rounded-full border-2 border-doodle-text/30" />
                        )}
                        {status.status === 'sending' && (
                          <Loader2 className="w-4 h-4 animate-spin text-doodle-accent" />
                        )}
                        {status.status === 'success' && (
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                        )}
                        {status.status === 'failed' && (
                          <XCircle className="w-4 h-4 text-red-600" />
                        )}
                        <span>SO{status.orderId}</span>
                      </div>
                      <div className="font-doodle text-xs">
                        {status.status === 'failed' ? (
                          <span className="text-red-600">{status.error}</span>
                        ) : (
                          <span className="text-doodle-text/60">{status.email}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            <DialogFooter>
              <Button onClick={handleClose} className="font-doodle">
                {sendingComplete ? 'Done' : 'Cancel'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default BulkEmailReceiptDialog;
