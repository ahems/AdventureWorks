import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, X, Printer } from 'lucide-react';
import { ReceiptData } from '@/services/mockReceiptService';

interface ReceiptPreviewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  receiptData: ReceiptData | null;
  onDownload: () => void;
  isDownloading?: boolean;
}

const ReceiptPreviewModal: React.FC<ReceiptPreviewModalProps> = ({
  open,
  onOpenChange,
  receiptData,
  onDownload,
  isDownloading = false,
}) => {
  if (!receiptData) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-doodle flex items-center gap-2">
            Receipt Preview - {receiptData.orderNumber}
          </DialogTitle>
        </DialogHeader>

        {/* Receipt Preview */}
        <div className="border-2 border-doodle-text/20 bg-white p-6 font-sans print:border-0">
          {/* Header */}
          <div className="text-center mb-6 border-b-2 border-doodle-text/10 pb-4">
            <h2 className="text-2xl font-bold text-doodle-text">AdventureWorks</h2>
            <p className="text-xs text-doodle-text/60 mt-1">
              1 Adventure Way, Bothell, WA 98011<br />
              (555) 123-4567 • hello@adventureworks.com
            </p>
          </div>

          {/* Order Receipt Title */}
          <h3 className="text-lg font-bold border-b-2 border-doodle-text pb-2 mb-4">
            ORDER RECEIPT
          </h3>

          {/* Order Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">Order Number</span>
              <span className="font-semibold">{receiptData.orderNumber}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">Order Date</span>
              <span className="font-semibold">{receiptData.orderDate}</span>
            </div>
            <div>
              <span className="text-[10px] uppercase text-doodle-text/50 block">Status</span>
              <span className="font-semibold">{receiptData.status}</span>
            </div>
            {receiptData.shipDate && (
              <div>
                <span className="text-[10px] uppercase text-doodle-text/50 block">Ship Date</span>
                <span className="font-semibold">{receiptData.shipDate}</span>
              </div>
            )}
          </div>

          {/* Customer Section */}
          <h4 className="text-sm font-bold border-b border-doodle-text/20 pb-1 mb-2">CUSTOMER</h4>
          <p className="mb-4 text-sm">
            <strong>{receiptData.customerName}</strong><br />
            {receiptData.customerEmail}
          </p>

          {/* Ship To Section */}
          <h4 className="text-sm font-bold border-b border-doodle-text/20 pb-1 mb-2">SHIP TO</h4>
          <p className="mb-4 text-sm">
            {receiptData.shippingAddress.street}<br />
            {receiptData.shippingAddress.city}, {receiptData.shippingAddress.state} {receiptData.shippingAddress.zip}<br />
            {receiptData.shippingAddress.country}
          </p>

          {/* Order Items */}
          <h4 className="text-sm font-bold border-b border-doodle-text/20 pb-1 mb-2">ORDER ITEMS</h4>
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="bg-doodle-text/5">
                <th className="text-left p-2 font-semibold">Qty</th>
                <th className="text-left p-2 font-semibold">Product</th>
                <th className="text-left p-2 font-semibold">SKU</th>
                <th className="text-right p-2 font-semibold">Unit Price</th>
                <th className="text-right p-2 font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {receiptData.items.map((item, index) => (
                <tr key={index} className="border-b border-doodle-text/10">
                  <td className="p-2">{item.qty}</td>
                  <td className="p-2">{item.product}</td>
                  <td className="p-2 text-doodle-text/60">{item.sku}</td>
                  <td className="p-2 text-right">${item.unitPrice.toFixed(2)}</td>
                  <td className="p-2 text-right">${item.total.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Totals */}
          <div className="flex justify-end">
            <div className="w-64">
              <div className="flex justify-between py-1 text-sm">
                <span>Subtotal:</span>
                <span>${receiptData.subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span>Shipping:</span>
                <span>${receiptData.shipping.toFixed(2)}</span>
              </div>
              <div className="text-[10px] text-doodle-text/50 text-right">
                Method: {receiptData.shippingMethod}
              </div>
              <div className="flex justify-between py-1 text-sm">
                <span>Tax:</span>
                <span>${receiptData.tax.toFixed(2)}</span>
              </div>
              <div className="flex justify-between py-2 text-lg font-bold border-t-2 border-doodle-text mt-2">
                <span>TOTAL:</span>
                <span className="text-doodle-green">${receiptData.total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="text-center mt-6 pt-4 border-t border-doodle-text/10 text-sm text-doodle-text/60 italic">
            Thank you for your order!<br />
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
          <Button
            onClick={onDownload}
            disabled={isDownloading}
            className="font-doodle"
          >
            <Download className="w-4 h-4 mr-2" />
            {isDownloading ? 'Downloading...' : 'Download'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ReceiptPreviewModal;
