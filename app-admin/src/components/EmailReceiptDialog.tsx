import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Mail, Send, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Order } from "@/types/order";
import { useCustomerEmailAddresses } from "@/hooks/useAdminCustomers";
import { getFunctionsApiUrl } from "@/lib/utils";

interface EmailReceiptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | null;
}

const EmailReceiptDialog: React.FC<EmailReceiptDialogProps> = ({
  open,
  onOpenChange,
  order,
}) => {
  const [selectedEmailId, setSelectedEmailId] = useState<string>("");
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();

  const { emails, isLoading: isLoadingEmails } = useCustomerEmailAddresses(
    open ? order?.CustomerID : undefined,
  );

  // Auto-select the first available email
  React.useEffect(() => {
    if (emails.length > 0 && !selectedEmailId) {
      setSelectedEmailId(String(emails[0].EmailAddressID));
    }
  }, [emails, selectedEmailId]);

  // Reset selection when order changes
  React.useEffect(() => {
    setSelectedEmailId("");
  }, [order?.SalesOrderID]);

  const handleSend = async () => {
    if (!order || !selectedEmailId) return;

    setIsSending(true);
    try {
      const res = await fetch(
        `${getFunctionsApiUrl()}/api/orders/generate-and-send-receipt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            SalesOrderId: order.SalesOrderID,
            CustomerId: order.CustomerID,
            EmailAddressId: Number(selectedEmailId),
          }),
        },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Server returned ${res.status}`);
      }

      toast({
        title: "Receipt sent",
        description: `Receipt for SO${order.SalesOrderID} has been emailed successfully.`,
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Failed to send receipt",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  if (!order) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-doodle flex items-center gap-2">
            <Mail className="w-5 h-5" />
            Email Receipt — SO{order.SalesOrderID}
          </DialogTitle>
          <DialogDescription className="font-doodle">
            Send a receipt for this order to the customer's email address.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Order info */}
          <div className="p-3 bg-doodle-text/5 rounded border border-doodle-text/10 text-sm font-doodle space-y-1">
            <div>
              <span className="text-doodle-text/60">Order:</span>{" "}
              <strong>SO{order.SalesOrderID}</strong>
            </div>
            <div>
              <span className="text-doodle-text/60">Date:</span>{" "}
              {new Date(order.OrderDate).toLocaleDateString()}
            </div>
            <div>
              <span className="text-doodle-text/60">Total:</span>{" "}
              <strong>${order.TotalDue.toFixed(2)}</strong>
            </div>
          </div>

          {/* Email selector */}
          <div className="space-y-2">
            <Label htmlFor="email-select" className="font-doodle">
              Send to
            </Label>
            {isLoadingEmails ? (
              <div className="flex items-center gap-2 text-sm text-doodle-text/60 font-doodle">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading email addresses…
              </div>
            ) : emails.length === 0 ? (
              <p className="text-sm text-destructive font-doodle">
                No email addresses found for this customer.
              </p>
            ) : (
              <Select
                value={selectedEmailId}
                onValueChange={setSelectedEmailId}
              >
                <SelectTrigger id="email-select" className="font-doodle">
                  <SelectValue placeholder="Select an email address" />
                </SelectTrigger>
                <SelectContent>
                  {emails.map((addr) => (
                    <SelectItem
                      key={addr.EmailAddressID}
                      value={String(addr.EmailAddressID)}
                      className="font-doodle"
                    >
                      {addr.EmailAddress}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
            disabled={isSending || !selectedEmailId || emails.length === 0}
            className="font-doodle"
          >
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending…
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Send Receipt
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EmailReceiptDialog;
