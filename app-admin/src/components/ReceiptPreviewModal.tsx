import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X, Printer } from "lucide-react";
import { Order } from "@/types/order";
import { ORDER_STATUS_CONFIG } from "@/types/order";

interface ReceiptPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | null;
}

const ReceiptPreviewModal: React.FC<ReceiptPreviewModalProps> = ({
  open,
  onOpenChange,
  order,
}) => {
  if (!order) return null;

  const statusConfig = ORDER_STATUS_CONFIG[order.Status];

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-doodle flex items-center gap-2">
            Receipt Preview — Order SO{order.SalesOrderID}
          </DialogTitle>
        </DialogHeader>

        {/* Receipt Preview */}
        <div className="border-2 border-doodle-text/20 bg-white p-6 font-sans print:border-0">
          {/* Header */}
          <div className="text-center mb-6 border-b-2 border-doodle-text/10 pb-4">
            <h2 className="text-2xl font-bold text-doodle-text">
              AdventureWorks
            </h2>
            <p className="text-xs text-doodle-text/60 mt-1">
              1 Adventure Way, Bothell, WA 98011
              <br />
              (555) 123-4567 • hello@adventureworks.com
            </p>
          </div>

          <h3 className="text-lg font-bold border-b-2 border-doodle-text pb-2 mb-4">
            ORDER RECEIPT
          </h3>

          {/* Order Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">
                Order Number
              </span>
              <span className="font-semibold">SO{order.SalesOrderID}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">
                Order Date
              </span>
              <span className="font-semibold">
                {new Date(order.OrderDate).toLocaleDateString()}
              </span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">
                Status
              </span>
              <span className="font-semibold">
                {statusConfig.icon} {statusConfig.label}
              </span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">
                Customer
              </span>
              <span className="font-semibold">#{order.CustomerID}</span>
            </div>
            {order.ShipDate && (
              <div>
                <span className="text-[10px] uppercase text-doodle-text/50 block">
                  Ship Date
                </span>
                <span className="font-semibold">
                  {new Date(order.ShipDate).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>

          {/* Order Items */}
          <h4 className="text-sm font-bold border-b border-doodle-text/20 pb-1 mb-2">
            ORDER ITEMS
          </h4>
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="bg-doodle-text/5">
                <th className="text-left p-2 font-semibold">Qty</th>
                <th className="text-left p-2 font-semibold">Product</th>
                <th className="text-right p-2 font-semibold">Unit Price</th>
                <th className="text-right p-2 font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.OrderItems.map((item) => (
                <tr
                  key={item.SalesOrderDetailID}
                  className="border-b border-doodle-text/10"
                >
                  <td className="p-2">{item.OrderQty}</td>
                  <td className="p-2">{item.ProductName}</td>
                  <td className="p-2 text-right">
                    ${item.UnitPrice.toFixed(2)}
                  </td>
                  <td className="p-2 text-right">
                    ${item.LineTotal.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64">
              <div className="flex justify-between py-1 text-sm">
                <span>Subtotal:</span>
                <span>${order.SubTotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span>Freight:</span>
                <span>${order.Freight.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span>Tax:</span>
                <span>${order.TaxAmt.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-2 text-lg font-bold border-t-2 border-doodle-text mt-2">
                <span>TOTAL:</span>
                <span className="text-doodle-green">
                  ${order.TotalDue.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          <div className="text-center mt-6 pt-4 border-t border-doodle-text/10 text-sm text-doodle-text/60 italic">
            Thank you for your order!
            <br />
            We hope you enjoy your adventure!
          </div>
        </div>

        <DialogFooter className="gap-2 print:hidden">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="font-doodle"
          >
            <X className="w-4 h-4 mr-2" />
            Close
          </Button>
          <Button
            variant="outline"
            onClick={handlePrint}
            className="font-doodle"
          >
            <Printer className="w-4 h-4 mr-2" />
            Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ReceiptPreviewModal;
