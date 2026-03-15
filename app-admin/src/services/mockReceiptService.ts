import { Order, getCustomerById } from '@/data/mockCustomers';

export interface ReceiptData {
  orderNumber: string;
  orderId: number;
  orderDate: string;
  customerId: number;
  customerName: string;
  customerEmail: string;
  status: string;
  shipDate: string | null;
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  items: {
    qty: number;
    product: string;
    sku: string;
    unitPrice: number;
    total: number;
  }[];
  subtotal: number;
  shipping: number;
  shippingMethod: string;
  tax: number;
  total: number;
  generatedAt: string;
}

// Simulated shipping methods
const shippingMethods = [
  'CARGO TRANSPORT 5',
  'OVERNIGHT J-FAST',
  'STANDARD GROUND',
  'EXPRESS DELIVERY',
];

// Mock SKU generation
const generateSKU = (productName: string): string => {
  const words = productName.split(' ');
  const prefix = words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${suffix}`;
};

export const generateReceiptData = (order: Order): ReceiptData => {
  const customer = getCustomerById(order.CustomerID);
  
  // Mock shipping address
  const mockAddresses = [
    { street: '123 Adventure Lane', city: 'Houston', state: 'TX', zip: '77491', country: 'United States' },
    { street: '456 Mountain View Rd', city: 'Denver', state: 'CO', zip: '80202', country: 'United States' },
    { street: '789 Coastal Highway', city: 'San Diego', state: 'CA', zip: '92101', country: 'United States' },
    { street: '321 Forest Trail', city: 'Seattle', state: 'WA', zip: '98101', country: 'United States' },
  ];
  
  const address = mockAddresses[order.CustomerID % mockAddresses.length];
  const shippingMethod = shippingMethods[order.SalesOrderID % shippingMethods.length];
  
  // Calculate ship date (1-3 days after order date)
  const orderDate = new Date(order.OrderDate);
  const shipDate = new Date(orderDate);
  shipDate.setDate(shipDate.getDate() + 1 + (order.SalesOrderID % 3));
  
  return {
    orderNumber: `SO${order.SalesOrderID}`,
    orderId: order.SalesOrderID,
    orderDate: orderDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    customerId: order.CustomerID,
    customerName: customer ? `${customer.FirstName} ${customer.LastName}` : 'Unknown Customer',
    customerEmail: customer?.EmailAddress || 'unknown@example.com',
    status: order.Status,
    shipDate: order.Status === 'Shipped' || order.Status === 'Delivered' 
      ? shipDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : null,
    shippingAddress: address,
    items: order.OrderItems.map(item => ({
      qty: item.OrderQty,
      product: item.ProductName,
      sku: generateSKU(item.ProductName),
      unitPrice: item.UnitPrice,
      total: item.LineTotal,
    })),
    subtotal: order.SubTotal,
    shipping: order.Freight,
    shippingMethod,
    tax: order.TaxAmt,
    total: order.TotalDue,
    generatedAt: new Date().toISOString(),
  };
};

// Simulate PDF regeneration (would call Azure Function in real implementation)
export const regenerateReceipt = async (orderId: number): Promise<{ success: boolean; message: string }> => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000));
  
  // Randomly simulate occasional "failures" for realism (10% chance)
  if (Math.random() < 0.1) {
    throw new Error('Receipt generation service temporarily unavailable. Please try again.');
  }
  
  return {
    success: true,
    message: `Receipt for order SO${orderId} has been regenerated successfully.`,
  };
};

// Simulate PDF download (would fetch from Azure Blob Storage in real implementation)
export const downloadReceipt = async (order: Order): Promise<Blob> => {
  const receiptData = generateReceiptData(order);
  
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 500));
  
  // Generate a simple HTML receipt that will be "downloaded" as a mock PDF
  const receiptHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Order Receipt - ${receiptData.orderNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; }
    .header { text-align: center; margin-bottom: 30px; }
    .company-name { font-size: 28px; font-weight: bold; color: #333; }
    .company-info { font-size: 12px; color: #666; margin-top: 10px; }
    h1 { font-size: 20px; border-bottom: 2px solid #333; padding-bottom: 10px; }
    .order-info { display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 20px; }
    .order-info div { flex: 1; min-width: 150px; }
    .label { font-size: 11px; color: #888; text-transform: uppercase; }
    .value { font-size: 14px; font-weight: 500; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { text-align: left; padding: 10px; background: #f5f5f5; font-size: 12px; }
    td { padding: 10px; border-bottom: 1px solid #eee; }
    .text-right { text-align: right; }
    .totals { margin-left: auto; width: 250px; }
    .totals div { display: flex; justify-content: space-between; padding: 5px 0; }
    .grand-total { font-size: 18px; font-weight: bold; border-top: 2px solid #333; padding-top: 10px; margin-top: 10px; }
    .footer { text-align: center; margin-top: 40px; color: #666; font-style: italic; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company-name">AdventureWorks</div>
    <div class="company-info">
      1 Adventure Way, Bothell, WA 98011<br>
      (555) 123-4567 • hello@adventureworks.com
    </div>
  </div>
  
  <h1>ORDER RECEIPT</h1>
  
  <div class="order-info">
    <div>
      <div class="label">Order Number</div>
      <div class="value">${receiptData.orderNumber}</div>
    </div>
    <div>
      <div class="label">Order Date</div>
      <div class="value">${receiptData.orderDate}</div>
    </div>
    <div>
      <div class="label">Status</div>
      <div class="value">${receiptData.status}</div>
    </div>
    ${receiptData.shipDate ? `
    <div>
      <div class="label">Ship Date</div>
      <div class="value">${receiptData.shipDate}</div>
    </div>
    ` : ''}
  </div>
  
  <h1>CUSTOMER</h1>
  <p><strong>${receiptData.customerName}</strong><br>${receiptData.customerEmail}</p>
  
  <h1>SHIP TO</h1>
  <p>
    ${receiptData.shippingAddress.street}<br>
    ${receiptData.shippingAddress.city}, ${receiptData.shippingAddress.state} ${receiptData.shippingAddress.zip}<br>
    ${receiptData.shippingAddress.country}
  </p>
  
  <h1>ORDER ITEMS</h1>
  <table>
    <thead>
      <tr>
        <th>Qty</th>
        <th>Product</th>
        <th>SKU</th>
        <th class="text-right">Unit Price</th>
        <th class="text-right">Total</th>
      </tr>
    </thead>
    <tbody>
      ${receiptData.items.map(item => `
        <tr>
          <td>${item.qty}</td>
          <td>${item.product}</td>
          <td>${item.sku}</td>
          <td class="text-right">$${item.unitPrice.toFixed(2)}</td>
          <td class="text-right">$${item.total.toFixed(2)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
  
  <div class="totals">
    <div><span>Subtotal:</span><span>$${receiptData.subtotal.toFixed(2)}</span></div>
    <div><span>Shipping:</span><span>$${receiptData.shipping.toFixed(2)}</span></div>
    <div><span style="font-size:11px;color:#888;">Method: ${receiptData.shippingMethod}</span></div>
    <div><span>Tax:</span><span>$${receiptData.tax.toFixed(2)}</span></div>
    <div class="grand-total"><span>TOTAL:</span><span>$${receiptData.total.toFixed(2)}</span></div>
  </div>
  
  <div class="footer">
    Thank you for your order!<br>
    We hope you enjoy your adventure!
  </div>
</body>
</html>
  `;
  
  // Convert to Blob (in real implementation, this would be a PDF from the server)
  return new Blob([receiptHtml], { type: 'text/html' });
};

// Trigger the actual download in the browser
export const triggerReceiptDownload = async (order: Order): Promise<void> => {
  const blob = await downloadReceipt(order);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `Receipt-SO${order.SalesOrderID}.html`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
