/**
 * Mock RPC Server - Simulates a backend RPC server with all available data
 * This provides the AI agent with tools to query customers, orders, products, and reviews
 */

import { products, categories } from '@/data/mockData';
import { mockCustomers, mockOrders, Customer, Order } from '@/data/mockCustomers';
import { mockReviews } from '@/data/mockReviews';

export interface RpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  executionTime: number;
}

export interface RpcTool {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    description: string;
    required: boolean;
  }[];
}

// Available RPC tools that the AI agent can use
export const RPC_TOOLS: RpcTool[] = [
  {
    name: 'getCustomers',
    description: 'Retrieve all customers or filter by state, city, or spending range',
    parameters: [
      { name: 'state', type: 'string', description: 'Filter by state abbreviation (e.g., "WA", "CA")', required: false },
      { name: 'city', type: 'string', description: 'Filter by city name', required: false },
      { name: 'minSpent', type: 'number', description: 'Minimum total spent amount', required: false },
      { name: 'maxSpent', type: 'number', description: 'Maximum total spent amount', required: false },
    ],
  },
  {
    name: 'getCustomerById',
    description: 'Get a specific customer by their ID',
    parameters: [
      { name: 'customerId', type: 'number', description: 'The customer ID to look up', required: true },
    ],
  },
  {
    name: 'getOrders',
    description: 'Retrieve all orders or filter by status, customer, or date range',
    parameters: [
      { name: 'status', type: 'string', description: 'Filter by order status (Pending, Processing, Shipped, Delivered, Cancelled)', required: false },
      { name: 'customerId', type: 'number', description: 'Filter by customer ID', required: false },
      { name: 'startDate', type: 'string', description: 'Filter orders after this date (ISO format)', required: false },
      { name: 'endDate', type: 'string', description: 'Filter orders before this date (ISO format)', required: false },
    ],
  },
  {
    name: 'getOrderById',
    description: 'Get a specific order by its ID, including line items',
    parameters: [
      { name: 'orderId', type: 'number', description: 'The order ID to look up', required: true },
    ],
  },
  {
    name: 'getProducts',
    description: 'Retrieve all products or filter by category, price range, or search term',
    parameters: [
      { name: 'categoryId', type: 'number', description: 'Filter by product category ID', required: false },
      { name: 'minPrice', type: 'number', description: 'Minimum list price', required: false },
      { name: 'maxPrice', type: 'number', description: 'Maximum list price', required: false },
      { name: 'search', type: 'string', description: 'Search term for product name', required: false },
    ],
  },
  {
    name: 'getProductById',
    description: 'Get a specific product by its ID',
    parameters: [
      { name: 'productId', type: 'number', description: 'The product ID to look up', required: true },
    ],
  },
  {
    name: 'getReviews',
    description: 'Retrieve all reviews or filter by product, rating, or customer',
    parameters: [
      { name: 'productId', type: 'number', description: 'Filter by product ID', required: false },
      { name: 'minRating', type: 'number', description: 'Minimum rating (1-5)', required: false },
      { name: 'customerId', type: 'number', description: 'Filter by customer ID', required: false },
    ],
  },
  {
    name: 'getCategories',
    description: 'Retrieve all product categories',
    parameters: [],
  },
  {
    name: 'getStats',
    description: 'Get overall business statistics including totals and averages',
    parameters: [],
  },
  {
    name: 'getTopCustomers',
    description: 'Get the top customers by total spending',
    parameters: [
      { name: 'limit', type: 'number', description: 'Number of customers to return (default: 5)', required: false },
    ],
  },
  {
    name: 'getRevenueByState',
    description: 'Get total revenue broken down by state',
    parameters: [],
  },
  // === Write Operations ===
  {
    name: 'createOrder',
    description: 'Create a new order for a customer',
    parameters: [
      { name: 'customerId', type: 'number', description: 'The customer ID placing the order', required: true },
      { name: 'items', type: 'array', description: 'Array of { productId, quantity } objects', required: true },
    ],
  },
  {
    name: 'updateOrderStatus',
    description: 'Update the status of an existing order',
    parameters: [
      { name: 'orderId', type: 'number', description: 'The order ID to update', required: true },
      { name: 'status', type: 'string', description: 'New status (Pending, Processing, Shipped, Delivered, Cancelled)', required: true },
    ],
  },
  {
    name: 'updateCustomer',
    description: 'Update customer information (email, phone, or address)',
    parameters: [
      { name: 'customerId', type: 'number', description: 'The customer ID to update', required: true },
      { name: 'email', type: 'string', description: 'New email address', required: false },
      { name: 'phone', type: 'string', description: 'New phone number', required: false },
      { name: 'addressLine1', type: 'string', description: 'New street address', required: false },
      { name: 'city', type: 'string', description: 'New city', required: false },
      { name: 'stateProvince', type: 'string', description: 'New state/province', required: false },
      { name: 'postalCode', type: 'string', description: 'New postal code', required: false },
    ],
  },
  // === Reports ===
  {
    name: 'generateSalesReport',
    description: 'Generate a sales report with totals, trends, and breakdowns',
    parameters: [
      { name: 'period', type: 'string', description: 'Report period: "daily", "weekly", "monthly", or "yearly"', required: false },
      { name: 'groupBy', type: 'string', description: 'Group by: "status", "customer", "product", or "state"', required: false },
    ],
  },
  {
    name: 'generateCustomerReport',
    description: 'Generate a customer acquisition and retention report',
    parameters: [
      { name: 'sortBy', type: 'string', description: 'Sort by: "spending", "orders", "recent"', required: false },
      { name: 'includeInactive', type: 'boolean', description: 'Include customers with no recent orders', required: false },
    ],
  },
  {
    name: 'generateInventoryReport',
    description: 'Generate product inventory and popularity report',
    parameters: [
      { name: 'categoryId', type: 'number', description: 'Filter by category', required: false },
      { name: 'sortBy', type: 'string', description: 'Sort by: "price", "popularity", "name"', required: false },
    ],
  },
  // === AI Image Generation ===
  {
    name: 'generateProductImage',
    description: 'Generate an AI product image based on a description or for a specific product',
    parameters: [
      { name: 'productId', type: 'number', description: 'Product ID to generate image for', required: false },
      { name: 'description', type: 'string', description: 'Custom description for the image', required: false },
      { name: 'style', type: 'string', description: 'Image style: "photo", "illustration", "3d-render", "sketch"', required: false },
      { name: 'background', type: 'string', description: 'Background type: "white", "gradient", "studio", "outdoor"', required: false },
    ],
  },
  // === AI Product Success Analysis ===
  {
    name: 'analyzeProductSuccess',
    description: 'AI-powered analysis of product success metrics including cart additions, abandonments, purchases, views, and review sentiment',
    parameters: [
      { name: 'productId', type: 'number', description: 'Product ID to analyze', required: true },
    ],
  },
];

// Simulate network delay
const simulateDelay = () => new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));

// RPC method implementations
export async function executeRpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
  const startTime = performance.now();
  await simulateDelay();

  try {
    let data: unknown;

    switch (method) {
      case 'getCustomers': {
        let result = [...mockCustomers];
        if (params.state) {
          result = result.filter(c => c.StateProvince.toLowerCase() === String(params.state).toLowerCase());
        }
        if (params.city) {
          result = result.filter(c => c.City.toLowerCase().includes(String(params.city).toLowerCase()));
        }
        if (params.minSpent !== undefined) {
          result = result.filter(c => c.TotalSpent >= Number(params.minSpent));
        }
        if (params.maxSpent !== undefined) {
          result = result.filter(c => c.TotalSpent <= Number(params.maxSpent));
        }
        data = result;
        break;
      }

      case 'getCustomerById': {
        const customer = mockCustomers.find(c => c.CustomerID === Number(params.customerId));
        if (!customer) {
          return { success: false, error: `Customer ${params.customerId} not found`, executionTime: performance.now() - startTime };
        }
        data = customer;
        break;
      }

      case 'getOrders': {
        let result = [...mockOrders];
        if (params.status) {
          result = result.filter(o => o.Status.toLowerCase() === String(params.status).toLowerCase());
        }
        if (params.customerId !== undefined) {
          result = result.filter(o => o.CustomerID === Number(params.customerId));
        }
        if (params.startDate) {
          const start = new Date(String(params.startDate));
          result = result.filter(o => new Date(o.OrderDate) >= start);
        }
        if (params.endDate) {
          const end = new Date(String(params.endDate));
          result = result.filter(o => new Date(o.OrderDate) <= end);
        }
        data = result;
        break;
      }

      case 'getOrderById': {
        const order = mockOrders.find(o => o.SalesOrderID === Number(params.orderId));
        if (!order) {
          return { success: false, error: `Order ${params.orderId} not found`, executionTime: performance.now() - startTime };
        }
        data = order;
        break;
      }

      case 'getProducts': {
        let result = [...products];
        if (params.categoryId !== undefined) {
          // Filter by subcategory since Product uses ProductSubcategoryID
          result = result.filter(p => p.ProductSubcategoryID === Number(params.categoryId));
        }
        if (params.minPrice !== undefined) {
          result = result.filter(p => p.ListPrice >= Number(params.minPrice));
        }
        if (params.maxPrice !== undefined) {
          result = result.filter(p => p.ListPrice <= Number(params.maxPrice));
        }
        if (params.search) {
          const searchLower = String(params.search).toLowerCase();
          result = result.filter(p => p.Name.toLowerCase().includes(searchLower));
        }
        data = result;
        break;
      }

      case 'getProductById': {
        const product = products.find(p => p.ProductID === Number(params.productId));
        if (!product) {
          return { success: false, error: `Product ${params.productId} not found`, executionTime: performance.now() - startTime };
        }
        data = product;
        break;
      }

      case 'getReviews': {
        let result = [...mockReviews];
        if (params.productId !== undefined) {
          result = result.filter(r => r.productId === Number(params.productId));
        }
        if (params.minRating !== undefined) {
          result = result.filter(r => r.rating >= Number(params.minRating));
        }
        // Note: Reviews don't have CustomerID in this schema, so we skip that filter
        data = result;
        break;
      }

      case 'getCategories': {
        data = categories;
        break;
      }

      case 'getStats': {
        const totalRevenue = mockCustomers.reduce((sum, c) => sum + c.TotalSpent, 0);
        const avgOrderValue = mockOrders.length > 0 
          ? mockOrders.reduce((sum, o) => sum + o.TotalDue, 0) / mockOrders.length 
          : 0;
        data = {
          totalCustomers: mockCustomers.length,
          totalOrders: mockOrders.length,
          totalProducts: products.length,
          totalReviews: mockReviews.length,
          totalRevenue,
          averageOrderValue: avgOrderValue,
          pendingOrders: mockOrders.filter(o => o.Status === 'Pending').length,
          processingOrders: mockOrders.filter(o => o.Status === 'Processing').length,
          shippedOrders: mockOrders.filter(o => o.Status === 'Shipped').length,
          deliveredOrders: mockOrders.filter(o => o.Status === 'Delivered').length,
          cancelledOrders: mockOrders.filter(o => o.Status === 'Cancelled').length,
        };
        break;
      }

      case 'getTopCustomers': {
        const limit = Number(params.limit) || 5;
        const sorted = [...mockCustomers].sort((a, b) => b.TotalSpent - a.TotalSpent);
        data = sorted.slice(0, limit);
        break;
      }

      case 'getRevenueByState': {
        const stateRevenue: Record<string, number> = {};
        mockCustomers.forEach(c => {
          stateRevenue[c.StateProvince] = (stateRevenue[c.StateProvince] || 0) + c.TotalSpent;
        });
        data = Object.entries(stateRevenue)
          .map(([state, revenue]) => ({ state, revenue }))
          .sort((a, b) => b.revenue - a.revenue);
        break;
      }

      // === Write Operations ===
      case 'createOrder': {
        const customerId = Number(params.customerId);
        const customer = mockCustomers.find(c => c.CustomerID === customerId);
        if (!customer) {
          return { success: false, error: `Customer ${customerId} not found`, executionTime: performance.now() - startTime };
        }
        const items = params.items as { productId: number; quantity: number }[];
        if (!items || items.length === 0) {
          return { success: false, error: 'No items provided for the order', executionTime: performance.now() - startTime };
        }
        
        const orderItems: Order['OrderItems'] = [];
        let subTotal = 0;
        
        for (const item of items) {
          const product = products.find(p => p.ProductID === item.productId);
          if (!product) {
            return { success: false, error: `Product ${item.productId} not found`, executionTime: performance.now() - startTime };
          }
          const lineTotal = product.ListPrice * item.quantity;
          subTotal += lineTotal;
          orderItems.push({
            SalesOrderDetailID: Math.floor(Math.random() * 10000),
            ProductID: product.ProductID,
            ProductName: product.Name,
            OrderQty: item.quantity,
            UnitPrice: product.ListPrice,
            LineTotal: lineTotal,
          });
        }
        
        const taxAmt = subTotal * 0.08;
        const freight = subTotal > 1000 ? 0 : 25;
        const newOrder: Order = {
          SalesOrderID: Math.max(...mockOrders.map(o => o.SalesOrderID)) + 1,
          CustomerID: customerId,
          OrderDate: new Date().toISOString(),
          DueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          ShipDate: null,
          Status: 'Pending',
          SubTotal: subTotal,
          TaxAmt: taxAmt,
          Freight: freight,
          TotalDue: subTotal + taxAmt + freight,
          OrderItems: orderItems,
        };
        
        mockOrders.push(newOrder);
        data = newOrder;
        break;
      }

      case 'updateOrderStatus': {
        const orderId = Number(params.orderId);
        const newStatus = String(params.status) as Order['Status'];
        const orderIndex = mockOrders.findIndex(o => o.SalesOrderID === orderId);
        
        if (orderIndex === -1) {
          return { success: false, error: `Order ${orderId} not found`, executionTime: performance.now() - startTime };
        }
        
        const validStatuses = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Cancelled'];
        if (!validStatuses.includes(newStatus)) {
          return { success: false, error: `Invalid status: ${newStatus}`, executionTime: performance.now() - startTime };
        }
        
        const oldStatus = mockOrders[orderIndex].Status;
        mockOrders[orderIndex].Status = newStatus;
        
        if (newStatus === 'Shipped' && !mockOrders[orderIndex].ShipDate) {
          mockOrders[orderIndex].ShipDate = new Date().toISOString();
        }
        
        data = { 
          order: mockOrders[orderIndex], 
          previousStatus: oldStatus, 
          newStatus 
        };
        break;
      }

      case 'updateCustomer': {
        const customerId = Number(params.customerId);
        const customerIndex = mockCustomers.findIndex(c => c.CustomerID === customerId);
        
        if (customerIndex === -1) {
          return { success: false, error: `Customer ${customerId} not found`, executionTime: performance.now() - startTime };
        }
        
        const updates: Partial<Customer> = {};
        if (params.email) { mockCustomers[customerIndex].EmailAddress = String(params.email); updates.EmailAddress = String(params.email); }
        if (params.phone) { mockCustomers[customerIndex].Phone = String(params.phone); updates.Phone = String(params.phone); }
        if (params.addressLine1) { mockCustomers[customerIndex].AddressLine1 = String(params.addressLine1); updates.AddressLine1 = String(params.addressLine1); }
        if (params.city) { mockCustomers[customerIndex].City = String(params.city); updates.City = String(params.city); }
        if (params.stateProvince) { mockCustomers[customerIndex].StateProvince = String(params.stateProvince); updates.StateProvince = String(params.stateProvince); }
        if (params.postalCode) { mockCustomers[customerIndex].PostalCode = String(params.postalCode); updates.PostalCode = String(params.postalCode); }
        
        data = { customer: mockCustomers[customerIndex], updatedFields: Object.keys(updates) };
        break;
      }

      // === Reports ===
      case 'generateSalesReport': {
        const groupBy = String(params.groupBy || 'status');
        const totalRevenue = mockOrders.reduce((sum, o) => sum + o.TotalDue, 0);
        const avgOrderValue = mockOrders.length > 0 ? totalRevenue / mockOrders.length : 0;
        
        let breakdown: Record<string, { count: number; revenue: number }> = {};
        
        if (groupBy === 'status') {
          mockOrders.forEach(o => {
            if (!breakdown[o.Status]) breakdown[o.Status] = { count: 0, revenue: 0 };
            breakdown[o.Status].count++;
            breakdown[o.Status].revenue += o.TotalDue;
          });
        } else if (groupBy === 'customer') {
          mockOrders.forEach(o => {
            const customer = mockCustomers.find(c => c.CustomerID === o.CustomerID);
            const key = customer ? `${customer.FirstName} ${customer.LastName}` : `Customer ${o.CustomerID}`;
            if (!breakdown[key]) breakdown[key] = { count: 0, revenue: 0 };
            breakdown[key].count++;
            breakdown[key].revenue += o.TotalDue;
          });
        } else if (groupBy === 'state') {
          mockOrders.forEach(o => {
            const customer = mockCustomers.find(c => c.CustomerID === o.CustomerID);
            const key = customer?.StateProvince || 'Unknown';
            if (!breakdown[key]) breakdown[key] = { count: 0, revenue: 0 };
            breakdown[key].count++;
            breakdown[key].revenue += o.TotalDue;
          });
        }
        
        data = {
          totalOrders: mockOrders.length,
          totalRevenue,
          avgOrderValue,
          breakdown: Object.entries(breakdown).map(([name, stats]) => ({ name, ...stats })).sort((a, b) => b.revenue - a.revenue),
        };
        break;
      }

      case 'generateCustomerReport': {
        const sortBy = String(params.sortBy || 'spending');
        let sorted = [...mockCustomers];
        
        if (sortBy === 'spending') {
          sorted.sort((a, b) => b.TotalSpent - a.TotalSpent);
        } else if (sortBy === 'orders') {
          sorted.sort((a, b) => b.TotalOrders - a.TotalOrders);
        } else if (sortBy === 'recent') {
          sorted.sort((a, b) => new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime());
        }
        
        const totalCustomers = mockCustomers.length;
        const totalSpending = mockCustomers.reduce((sum, c) => sum + c.TotalSpent, 0);
        const avgSpending = totalCustomers > 0 ? totalSpending / totalCustomers : 0;
        const stateDistribution: Record<string, number> = {};
        mockCustomers.forEach(c => {
          stateDistribution[c.StateProvince] = (stateDistribution[c.StateProvince] || 0) + 1;
        });
        
        data = {
          totalCustomers,
          totalSpending,
          avgSpending,
          topCustomers: sorted.slice(0, 5).map(c => ({
            name: `${c.FirstName} ${c.LastName}`,
            spent: c.TotalSpent,
            orders: c.TotalOrders,
            location: `${c.City}, ${c.StateProvince}`,
          })),
          stateDistribution: Object.entries(stateDistribution).map(([state, count]) => ({ state, count })).sort((a, b) => b.count - a.count),
        };
        break;
      }

      case 'generateInventoryReport': {
        const sortBy = String(params.sortBy || 'popularity');
        let filtered = [...products];
        
        if (params.categoryId !== undefined) {
          filtered = filtered.filter(p => p.ProductSubcategoryID === Number(params.categoryId));
        }
        
        // Get review counts for popularity
        const productReviewCounts: Record<number, number> = {};
        mockReviews.forEach(r => {
          productReviewCounts[r.productId] = (productReviewCounts[r.productId] || 0) + 1;
        });
        
        if (sortBy === 'price') {
          filtered.sort((a, b) => b.ListPrice - a.ListPrice);
        } else if (sortBy === 'popularity') {
          filtered.sort((a, b) => (productReviewCounts[b.ProductID] || 0) - (productReviewCounts[a.ProductID] || 0));
        } else if (sortBy === 'name') {
          filtered.sort((a, b) => a.Name.localeCompare(b.Name));
        }
        
        const categoryBreakdown: Record<string, { count: number; avgPrice: number; totalValue: number }> = {};
        products.forEach(p => {
          const cat = categories.find(c => c.ProductCategoryID === p.ProductSubcategoryID)?.Name || 'Uncategorized';
          if (!categoryBreakdown[cat]) categoryBreakdown[cat] = { count: 0, avgPrice: 0, totalValue: 0 };
          categoryBreakdown[cat].count++;
          categoryBreakdown[cat].totalValue += p.ListPrice;
        });
        Object.values(categoryBreakdown).forEach(stats => {
          stats.avgPrice = stats.count > 0 ? stats.totalValue / stats.count : 0;
        });
        
        data = {
          totalProducts: products.length,
          filteredCount: filtered.length,
          topProducts: filtered.slice(0, 10).map(p => ({
            id: p.ProductID,
            name: p.Name,
            price: p.ListPrice,
            reviews: productReviewCounts[p.ProductID] || 0,
          })),
          categoryBreakdown: Object.entries(categoryBreakdown).map(([name, stats]) => ({ name, ...stats })),
        };
        break;
      }

      case 'generateProductImage': {
        const productId = params.productId ? Number(params.productId) : null;
        const description = params.description ? String(params.description) : null;
        const style = String(params.style || 'photo');
        const background = String(params.background || 'white');
        
        let productName = description || 'Custom Product';
        let productDetails = '';
        
        if (productId) {
          const product = products.find(p => p.ProductID === productId);
          if (!product) {
            return { success: false, error: `Product ${productId} not found`, executionTime: performance.now() - startTime };
          }
          productName = product.Name;
          productDetails = `Subcategory ID: ${product.ProductSubcategoryID}`;
        }
        
        // Generate a mock image URL based on the product name
        const styleLabels: Record<string, string> = {
          'photo': 'Professional Product Photography',
          'illustration': 'Digital Illustration',
          '3d-render': '3D Rendered Image',
          'sketch': 'Hand-drawn Sketch Style',
        };
        
        const backgroundLabels: Record<string, string> = {
          'white': 'Clean White Background',
          'gradient': 'Modern Gradient Background',
          'studio': 'Professional Studio Lighting',
          'outdoor': 'Natural Outdoor Setting',
        };
        
        // Create mock image data (in a real app this would call an AI image API)
        const imageId = Math.random().toString(36).substring(7);
        const mockImageUrl = `https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=512&h=512&fit=crop&q=80&${imageId}`;
        
        data = {
          imageUrl: mockImageUrl,
          productId,
          productName,
          productDetails,
          style: styleLabels[style] || style,
          background: backgroundLabels[background] || background,
          prompt: description || `A ${style} image of ${productName} on a ${background} background`,
          generatedAt: new Date().toISOString(),
          note: '🎨 This is a simulated AI-generated image. In production, this would use DALL-E, Stable Diffusion, or similar AI image generation APIs.',
        };
        break;
      }

      case 'analyzeProductSuccess': {
        const productId = Number(params.productId);
        const product = products.find(p => p.ProductID === productId);
        
        if (!product) {
          return { success: false, error: `Product ${productId} not found`, executionTime: performance.now() - startTime };
        }
        
        // Get reviews for this product
        const productReviews = mockReviews.filter(r => r.productId === productId);
        const avgRating = productReviews.length > 0 
          ? productReviews.reduce((sum, r) => sum + r.rating, 0) / productReviews.length 
          : 0;
        
        // Generate realistic mock analytics based on product attributes
        const priceMultiplier = product.ListPrice > 1000 ? 0.6 : product.ListPrice > 500 ? 0.8 : 1;
        const baseViews = Math.floor(Math.random() * 5000 + 1000);
        const viewToCartRate = (Math.random() * 0.15 + 0.05) * priceMultiplier;
        const cartToAbandonRate = Math.random() * 0.4 + 0.3;
        const cartToPurchaseRate = 1 - cartToAbandonRate;
        
        const views = baseViews;
        const addedToCart = Math.floor(views * viewToCartRate);
        const abandonedInCart = Math.floor(addedToCart * cartToAbandonRate);
        const purchased = Math.floor(addedToCart * cartToPurchaseRate);
        const viewedNotAdded = views - addedToCart;
        
        // AI-generated insights based on the metrics
        const insights: string[] = [];
        const conversionRate = (purchased / views) * 100;
        const cartConversionRate = addedToCart > 0 ? (purchased / addedToCart) * 100 : 0;
        const abandonmentRate = addedToCart > 0 ? (abandonedInCart / addedToCart) * 100 : 0;
        
        // Analyze performance
        if (conversionRate < 1) {
          insights.push('⚠️ Low overall conversion rate. Consider improving product visibility or adjusting pricing.');
        } else if (conversionRate > 3) {
          insights.push('✅ Strong conversion rate indicates good product-market fit.');
        }
        
        if (abandonmentRate > 50) {
          insights.push('🛒 High cart abandonment rate. Consider cart recovery emails or checkout optimization.');
        } else if (abandonmentRate < 30) {
          insights.push('✅ Low cart abandonment - customers who add this product tend to purchase.');
        }
        
        if (viewedNotAdded / views > 0.9) {
          insights.push('👀 Many views but few cart additions. Review product images, descriptions, or pricing.');
        }
        
        if (avgRating >= 4.5 && productReviews.length >= 3) {
          insights.push('⭐ Excellent review score is likely boosting purchase confidence.');
        } else if (avgRating < 3 && productReviews.length >= 2) {
          insights.push('📉 Low review score may be hurting conversions. Address customer concerns.');
        }
        
        if (productReviews.length < 3) {
          insights.push('📝 Limited reviews. Encourage customers to leave feedback to build trust.');
        }
        
        // Review sentiment analysis
        const positiveReviews = productReviews.filter(r => r.rating >= 4).length;
        const negativeReviews = productReviews.filter(r => r.rating <= 2).length;
        const neutralReviews = productReviews.length - positiveReviews - negativeReviews;
        
        // Success score calculation (0-100)
        let successScore = 50;
        successScore += Math.min(conversionRate * 10, 20);
        successScore += Math.min((100 - abandonmentRate) * 0.2, 15);
        successScore += avgRating * 3;
        successScore = Math.min(Math.max(successScore, 0), 100);
        
        const successTier = successScore >= 80 ? 'Excellent' : successScore >= 60 ? 'Good' : successScore >= 40 ? 'Average' : 'Needs Improvement';
        
        data = {
          productId,
          productName: product.Name,
          productPrice: product.ListPrice,
          metrics: {
            views,
            addedToCart,
            abandonedInCart,
            purchased,
            viewedNotAdded,
          },
          rates: {
            viewToCartRate: (viewToCartRate * 100).toFixed(1),
            cartConversionRate: cartConversionRate.toFixed(1),
            abandonmentRate: abandonmentRate.toFixed(1),
            overallConversionRate: conversionRate.toFixed(2),
          },
          reviews: {
            count: productReviews.length,
            averageRating: avgRating.toFixed(1),
            positive: positiveReviews,
            neutral: neutralReviews,
            negative: negativeReviews,
            recentReviews: productReviews.slice(0, 3).map(r => ({
              title: r.title,
              rating: r.rating,
              preview: r.comment.substring(0, 100) + (r.comment.length > 100 ? '...' : ''),
            })),
          },
          aiAnalysis: {
            successScore: Math.round(successScore),
            successTier,
            insights,
            recommendation: successScore >= 70 
              ? 'Continue current strategy. Consider featuring this product more prominently.'
              : successScore >= 50
              ? 'Focus on reducing cart abandonment and improving product page engagement.'
              : 'Significant improvements needed. Review pricing, imagery, and customer feedback.',
          },
          analyzedAt: new Date().toISOString(),
        };
        break;
      }

      default:
        return { success: false, error: `Unknown method: ${method}`, executionTime: performance.now() - startTime };
    }

    return { success: true, data, executionTime: performance.now() - startTime };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error', 
      executionTime: performance.now() - startTime 
    };
  }
}

// AI Agent logic - parses user messages and determines which RPC calls to make
export interface AgentMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: { method: string; params: Record<string, unknown>; result: RpcResponse }[];
}

export async function processAgentMessage(userMessage: string, history: AgentMessage[]): Promise<AgentMessage> {
  const message = userMessage.toLowerCase();
  const toolCalls: AgentMessage['toolCalls'] = [];
  let response = '';

  // Analyze intent and execute relevant RPC calls
  if (message.includes('stat') || message.includes('overview') || message.includes('summary') || message.includes('dashboard')) {
    const result = await executeRpc('getStats');
    toolCalls.push({ method: 'getStats', params: {}, result });
    if (result.success && result.data) {
      const stats = result.data as Record<string, number>;
      response = `📊 **Business Overview**\n\n` +
        `• **Customers:** ${stats.totalCustomers}\n` +
        `• **Orders:** ${stats.totalOrders} (${stats.pendingOrders} pending, ${stats.processingOrders} processing)\n` +
        `• **Products:** ${stats.totalProducts}\n` +
        `• **Total Revenue:** $${stats.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `• **Avg Order Value:** $${stats.averageOrderValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
    }
  }
  else if (message.includes('top customer') || message.includes('best customer') || message.includes('highest spending')) {
    const limitMatch = message.match(/(\d+)/);
    const limit = limitMatch ? parseInt(limitMatch[1]) : 5;
    const result = await executeRpc('getTopCustomers', { limit });
    toolCalls.push({ method: 'getTopCustomers', params: { limit }, result });
    if (result.success && result.data) {
      const customers = result.data as Customer[];
      response = `🏆 **Top ${customers.length} Customers by Spending**\n\n` +
        customers.map((c, i) => 
          `${i + 1}. **${c.FirstName} ${c.LastName}** (${c.City}, ${c.StateProvince})\n   💰 $${c.TotalSpent.toLocaleString(undefined, { minimumFractionDigits: 2 })} • ${c.TotalOrders} orders`
        ).join('\n\n');
    }
  }
  else if (message.includes('revenue by state') || message.includes('state revenue') || message.includes('revenue breakdown')) {
    const result = await executeRpc('getRevenueByState');
    toolCalls.push({ method: 'getRevenueByState', params: {}, result });
    if (result.success && result.data) {
      const stateData = result.data as { state: string; revenue: number }[];
      response = `📍 **Revenue by State**\n\n` +
        stateData.map(s => 
          `• **${s.state}:** $${s.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
        ).join('\n');
    }
  }
  else if (message.includes('pending order') || message.includes('orders pending')) {
    const result = await executeRpc('getOrders', { status: 'Pending' });
    toolCalls.push({ method: 'getOrders', params: { status: 'Pending' }, result });
    if (result.success && result.data) {
      const orders = result.data as Order[];
      if (orders.length === 0) {
        response = '✅ No pending orders at this time!';
      } else {
        response = `⏳ **Pending Orders (${orders.length})**\n\n` +
          orders.map(o => 
            `• **Order #${o.SalesOrderID}** - $${o.TotalDue.toFixed(2)}\n  Customer ID: ${o.CustomerID} • Due: ${new Date(o.DueDate).toLocaleDateString()}`
          ).join('\n\n');
      }
    }
  }
  else if (message.includes('order') && message.match(/#?(\d{5})/)) {
    const orderMatch = message.match(/#?(\d{5})/);
    if (orderMatch) {
      const orderId = parseInt(orderMatch[1]);
      const result = await executeRpc('getOrderById', { orderId });
      toolCalls.push({ method: 'getOrderById', params: { orderId }, result });
      if (result.success && result.data) {
        const order = result.data as Order;
        response = `📦 **Order #${order.SalesOrderID}**\n\n` +
          `• **Status:** ${order.Status}\n` +
          `• **Customer ID:** ${order.CustomerID}\n` +
          `• **Order Date:** ${new Date(order.OrderDate).toLocaleDateString()}\n` +
          `• **Due Date:** ${new Date(order.DueDate).toLocaleDateString()}\n` +
          `• **Total:** $${order.TotalDue.toFixed(2)}\n\n` +
          `**Items:**\n` +
          order.OrderItems.map(item => 
            `  • ${item.ProductName} × ${item.OrderQty} = $${item.LineTotal.toFixed(2)}`
          ).join('\n');
      } else {
        response = `❌ Order #${orderId} not found.`;
      }
    }
  }
  else if (message.includes('customer') && message.match(/(\d{4})/)) {
    const customerMatch = message.match(/(\d{4})/);
    if (customerMatch) {
      const customerId = parseInt(customerMatch[1]);
      const customerResult = await executeRpc('getCustomerById', { customerId });
      const ordersResult = await executeRpc('getOrders', { customerId });
      toolCalls.push({ method: 'getCustomerById', params: { customerId }, result: customerResult });
      toolCalls.push({ method: 'getOrders', params: { customerId }, result: ordersResult });
      
      if (customerResult.success && customerResult.data) {
        const customer = customerResult.data as Customer;
        const orders = (ordersResult.data as Order[]) || [];
        response = `👤 **Customer: ${customer.FirstName} ${customer.LastName}**\n\n` +
          `• **ID:** ${customer.CustomerID}\n` +
          `• **Email:** ${customer.EmailAddress}\n` +
          `• **Phone:** ${customer.Phone}\n` +
          `• **Location:** ${customer.City}, ${customer.StateProvince}\n` +
          `• **Total Spent:** $${customer.TotalSpent.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
          `• **Total Orders:** ${customer.TotalOrders}\n\n` +
          `**Recent Orders:**\n` +
          (orders.length > 0 
            ? orders.slice(0, 3).map(o => `  • #${o.SalesOrderID} - ${o.Status} - $${o.TotalDue.toFixed(2)}`).join('\n')
            : '  No orders found');
      } else {
        response = `❌ Customer #${customerId} not found.`;
      }
    }
  }
  else if (message.includes('customer') && (message.includes('california') || message.includes(' ca '))) {
    const result = await executeRpc('getCustomers', { state: 'CA' });
    toolCalls.push({ method: 'getCustomers', params: { state: 'CA' }, result });
    if (result.success && result.data) {
      const customers = result.data as Customer[];
      response = `🌴 **California Customers (${customers.length})**\n\n` +
        customers.map(c => 
          `• **${c.FirstName} ${c.LastName}** - ${c.City}\n  💰 $${c.TotalSpent.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
        ).join('\n\n');
    }
  }
  else if (message.includes('product') && message.includes('expensive') || message.includes('premium')) {
    const result = await executeRpc('getProducts', { minPrice: 2000 });
    toolCalls.push({ method: 'getProducts', params: { minPrice: 2000 }, result });
    if (result.success && result.data) {
      const prods = result.data as typeof products;
      response = `💎 **Premium Products ($2000+)**\n\n` +
        prods.slice(0, 10).map(p => 
          `• **${p.Name}**\n  $${p.ListPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
        ).join('\n\n');
    }
  }
  else if (message.includes('categories') || message.includes('category list')) {
    const result = await executeRpc('getCategories');
    toolCalls.push({ method: 'getCategories', params: {}, result });
    if (result.success && result.data) {
      const cats = result.data as typeof categories;
      response = `📂 **Product Categories**\n\n` +
        cats.map(c => `• ${c.Name}`).join('\n');
    }
  }
  else if (message.includes('help') || message.includes('what can you do')) {
    response = `🤖 **I'm your AdventureWorks AI Assistant!**\n\n` +
      `I can help you with:\n\n` +
      `📊 **Business Insights**\n` +
      `• "Show me the stats" - Get business overview\n` +
      `• "Top 5 customers" - See highest spenders\n` +
      `• "Revenue by state" - Geographic breakdown\n\n` +
      `📦 **Orders**\n` +
      `• "Show pending orders" - View orders needing attention\n` +
      `• "Order #70001" - Look up specific order\n` +
      `• "Create order for customer 1001" - New order\n` +
      `• "Update order 70001 to shipped" - Change status\n\n` +
      `👥 **Customers**\n` +
      `• "Customer 1001" - Get customer details\n` +
      `• "Customers in California" - Filter by location\n` +
      `• "Update customer 1001 email" - Modify info\n\n` +
      `🛍️ **Products**\n` +
      `• "Show premium products" - High-value items\n` +
      `• "List categories" - Browse categories\n\n` +
      `🔍 **AI Product Success Analysis**\n` +
      `• "Analyze product 749" - Full success analysis\n` +
      `• "How is product 749 doing?" - Performance check\n` +
      `• "Product 749 conversion analysis" - Cart & purchase metrics\n\n` +
      `🎨 **AI Image Generation**\n` +
      `• "Generate image for product 749" - Create product image\n` +
      `• "Create 3D render of a mountain bike" - Custom image\n` +
      `• "Make illustration with gradient background" - Styled image\n\n` +
      `📈 **Reports**\n` +
      `• "Generate sales report" - Sales breakdown\n` +
      `• "Generate customer report" - Customer analysis\n` +
      `• "Generate inventory report" - Product insights`;
  }
  // === Create Order Intent ===
  else if ((message.includes('create') || message.includes('new') || message.includes('place')) && message.includes('order')) {
    const customerMatch = message.match(/customer\s*#?(\d{4})/i) || message.match(/for\s*#?(\d{4})/i);
    const productMatches = message.match(/product\s*#?(\d+)/gi);
    
    if (!customerMatch) {
      response = `📝 **Create Order**\n\nTo create an order, please specify:\n• Customer ID (e.g., "Create order for customer 1001")\n• Optionally, product IDs (e.g., "with product 749")`;
    } else {
      const customerId = parseInt(customerMatch[1]);
      const items: { productId: number; quantity: number }[] = [];
      
      if (productMatches) {
        productMatches.forEach(match => {
          const id = parseInt(match.match(/\d+/)?.[0] || '0');
          if (id) items.push({ productId: id, quantity: 1 });
        });
      }
      
      if (items.length === 0) {
        // Default to a sample product
        items.push({ productId: 749, quantity: 1 });
      }
      
      const result = await executeRpc('createOrder', { customerId, items });
      toolCalls.push({ method: 'createOrder', params: { customerId, items }, result });
      
      if (result.success && result.data) {
        const order = result.data as Order;
        response = `✅ **Order Created Successfully!**\n\n` +
          `• **Order ID:** #${order.SalesOrderID}\n` +
          `• **Customer ID:** ${order.CustomerID}\n` +
          `• **Status:** ${order.Status}\n` +
          `• **Total:** $${order.TotalDue.toFixed(2)}\n\n` +
          `**Items:**\n` +
          order.OrderItems.map(item => `  • ${item.ProductName} × ${item.OrderQty} = $${item.LineTotal.toFixed(2)}`).join('\n');
      } else {
        response = `❌ Failed to create order: ${result.error}`;
      }
    }
  }
  // === Update Order Status Intent ===
  else if ((message.includes('update') || message.includes('change') || message.includes('set') || message.includes('mark')) && message.includes('order') && (message.includes('status') || message.includes('shipped') || message.includes('delivered') || message.includes('processing') || message.includes('cancelled') || message.includes('pending'))) {
    const orderMatch = message.match(/#?(\d{5})/);
    let newStatus = '';
    
    if (message.includes('shipped') || message.includes('ship')) newStatus = 'Shipped';
    else if (message.includes('delivered') || message.includes('deliver')) newStatus = 'Delivered';
    else if (message.includes('processing') || message.includes('process')) newStatus = 'Processing';
    else if (message.includes('cancelled') || message.includes('cancel')) newStatus = 'Cancelled';
    else if (message.includes('pending')) newStatus = 'Pending';
    
    if (!orderMatch) {
      response = `📦 **Update Order Status**\n\nPlease specify an order ID (e.g., "Update order 70001 to shipped")`;
    } else if (!newStatus) {
      response = `📦 **Update Order Status**\n\nPlease specify a status: Pending, Processing, Shipped, Delivered, or Cancelled`;
    } else {
      const orderId = parseInt(orderMatch[1]);
      const result = await executeRpc('updateOrderStatus', { orderId, status: newStatus });
      toolCalls.push({ method: 'updateOrderStatus', params: { orderId, status: newStatus }, result });
      
      if (result.success && result.data) {
        const { order, previousStatus } = result.data as { order: Order; previousStatus: string; newStatus: string };
        response = `✅ **Order Status Updated!**\n\n` +
          `• **Order #${order.SalesOrderID}**\n` +
          `• **Status:** ${previousStatus} → **${order.Status}**\n` +
          `• **Total:** $${order.TotalDue.toFixed(2)}` +
          (order.ShipDate ? `\n• **Shipped:** ${new Date(order.ShipDate).toLocaleDateString()}` : '');
      } else {
        response = `❌ Failed to update order: ${result.error}`;
      }
    }
  }
  // === Update Customer Intent ===
  else if ((message.includes('update') || message.includes('change') || message.includes('edit') || message.includes('modify')) && message.includes('customer')) {
    const customerMatch = message.match(/customer\s*#?(\d{4})/i) || message.match(/#?(\d{4})/);
    
    if (!customerMatch) {
      response = `👤 **Update Customer**\n\nPlease specify a customer ID (e.g., "Update customer 1001 email to newemail@example.com")`;
    } else {
      const customerId = parseInt(customerMatch[1]);
      const updates: Record<string, string> = {};
      
      const emailMatch = message.match(/email\s+(?:to\s+)?([^\s]+@[^\s]+)/i);
      const phoneMatch = message.match(/phone\s+(?:to\s+)?(\([0-9]{3}\)\s*[0-9]{3}-[0-9]{4}|\d{10,})/i);
      const cityMatch = message.match(/city\s+(?:to\s+)?([A-Za-z\s]+?)(?:\s+state|\s+phone|\s+email|$)/i);
      
      if (emailMatch) updates.email = emailMatch[1];
      if (phoneMatch) updates.phone = phoneMatch[1];
      if (cityMatch) updates.city = cityMatch[1].trim();
      
      if (Object.keys(updates).length === 0) {
        // Just show customer info with edit hints
        const customerResult = await executeRpc('getCustomerById', { customerId });
        toolCalls.push({ method: 'getCustomerById', params: { customerId }, result: customerResult });
        
        if (customerResult.success && customerResult.data) {
          const customer = customerResult.data as Customer;
          response = `👤 **Customer ${customer.FirstName} ${customer.LastName}**\n\n` +
            `Current info:\n` +
            `• **Email:** ${customer.EmailAddress}\n` +
            `• **Phone:** ${customer.Phone}\n` +
            `• **Address:** ${customer.AddressLine1}, ${customer.City}, ${customer.StateProvince} ${customer.PostalCode}\n\n` +
            `To update, say something like:\n` +
            `• "Update customer ${customerId} email to newemail@example.com"\n` +
            `• "Update customer ${customerId} phone to (555) 999-8888"`;
        } else {
          response = `❌ Customer ${customerId} not found.`;
        }
      } else {
        const result = await executeRpc('updateCustomer', { customerId, ...updates });
        toolCalls.push({ method: 'updateCustomer', params: { customerId, ...updates }, result });
        
        if (result.success && result.data) {
          const { customer, updatedFields } = result.data as { customer: Customer; updatedFields: string[] };
          response = `✅ **Customer Updated!**\n\n` +
            `• **${customer.FirstName} ${customer.LastName}** (ID: ${customer.CustomerID})\n` +
            `• **Updated:** ${updatedFields.join(', ')}\n\n` +
            `Current info:\n` +
            `• **Email:** ${customer.EmailAddress}\n` +
            `• **Phone:** ${customer.Phone}\n` +
            `• **Location:** ${customer.City}, ${customer.StateProvince}`;
        } else {
          response = `❌ Failed to update customer: ${result.error}`;
        }
      }
    }
  }
  // === Sales Report Intent ===
  else if ((message.includes('sales report') || message.includes('revenue report')) || (message.includes('generate') && message.includes('sales'))) {
    let groupBy = 'status';
    if (message.includes('by customer') || message.includes('per customer')) groupBy = 'customer';
    else if (message.includes('by state') || message.includes('per state') || message.includes('by region')) groupBy = 'state';
    
    const result = await executeRpc('generateSalesReport', { groupBy });
    toolCalls.push({ method: 'generateSalesReport', params: { groupBy }, result });
    
    if (result.success && result.data) {
      const report = result.data as { totalOrders: number; totalRevenue: number; avgOrderValue: number; breakdown: { name: string; count: number; revenue: number }[] };
      response = `📈 **Sales Report** (by ${groupBy})\n\n` +
        `• **Total Orders:** ${report.totalOrders}\n` +
        `• **Total Revenue:** $${report.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `• **Avg Order Value:** $${report.avgOrderValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\n` +
        `**Breakdown:**\n` +
        report.breakdown.slice(0, 8).map(b => `  • **${b.name}:** ${b.count} orders, $${b.revenue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`).join('\n');
    }
  }
  // === Customer Report Intent ===
  else if ((message.includes('customer report') || message.includes('customer analysis')) || (message.includes('generate') && message.includes('customer'))) {
    let sortBy = 'spending';
    if (message.includes('by order') || message.includes('most orders')) sortBy = 'orders';
    else if (message.includes('recent') || message.includes('newest')) sortBy = 'recent';
    
    const result = await executeRpc('generateCustomerReport', { sortBy });
    toolCalls.push({ method: 'generateCustomerReport', params: { sortBy }, result });
    
    if (result.success && result.data) {
      const report = result.data as { totalCustomers: number; totalSpending: number; avgSpending: number; topCustomers: { name: string; spent: number; orders: number; location: string }[]; stateDistribution: { state: string; count: number }[] };
      response = `👥 **Customer Report** (sorted by ${sortBy})\n\n` +
        `• **Total Customers:** ${report.totalCustomers}\n` +
        `• **Total Lifetime Value:** $${report.totalSpending.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n` +
        `• **Avg Customer Value:** $${report.avgSpending.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\n` +
        `**Top Customers:**\n` +
        report.topCustomers.map((c, i) => `  ${i + 1}. **${c.name}** - $${c.spent.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${c.orders} orders)\n     📍 ${c.location}`).join('\n') +
        `\n\n**Customers by State:**\n` +
        report.stateDistribution.slice(0, 5).map(s => `  • **${s.state}:** ${s.count} customers`).join('\n');
    }
  }
  // === Inventory Report Intent ===
  else if ((message.includes('inventory report') || message.includes('product report')) || (message.includes('generate') && message.includes('inventory'))) {
    let sortBy = 'popularity';
    if (message.includes('by price') || message.includes('expensive')) sortBy = 'price';
    else if (message.includes('by name') || message.includes('alphabetical')) sortBy = 'name';
    
    const result = await executeRpc('generateInventoryReport', { sortBy });
    toolCalls.push({ method: 'generateInventoryReport', params: { sortBy }, result });
    
    if (result.success && result.data) {
      const report = result.data as { totalProducts: number; filteredCount: number; topProducts: { id: number; name: string; price: number; reviews: number }[]; categoryBreakdown: { name: string; count: number; avgPrice: number }[] };
      response = `📦 **Inventory Report** (sorted by ${sortBy})\n\n` +
        `• **Total Products:** ${report.totalProducts}\n\n` +
        `**Top Products:**\n` +
        report.topProducts.slice(0, 8).map((p, i) => `  ${i + 1}. **${p.name}**\n     $${p.price.toLocaleString(undefined, { minimumFractionDigits: 2 })} • ${p.reviews} reviews`).join('\n') +
        `\n\n**By Category:**\n` +
        report.categoryBreakdown.slice(0, 6).map(c => `  • **${c.name}:** ${c.count} products, avg $${c.avgPrice.toFixed(2)}`).join('\n');
    }
  }
  // === AI Product Image Generation Intent ===
  else if ((message.includes('generate') || message.includes('create') || message.includes('make')) && (message.includes('image') || message.includes('photo') || message.includes('picture'))) {
    const productMatch = message.match(/product\s*#?(\d+)/i) || message.match(/for\s+#?(\d+)/i);
    const productId = productMatch ? parseInt(productMatch[1]) : null;
    
    // Extract style preference
    let style = 'photo';
    if (message.includes('illustration') || message.includes('illustrated')) style = 'illustration';
    else if (message.includes('3d') || message.includes('render')) style = '3d-render';
    else if (message.includes('sketch') || message.includes('drawing')) style = 'sketch';
    
    // Extract background preference
    let background = 'white';
    if (message.includes('gradient')) background = 'gradient';
    else if (message.includes('studio')) background = 'studio';
    else if (message.includes('outdoor') || message.includes('nature')) background = 'outdoor';
    
    // Extract custom description (everything after "of" or "showing" or "with")
    const descMatch = message.match(/(?:of|showing|with|depicting)\s+(.+?)(?:\s+in\s+|\s+on\s+|\s+style|\s+background|$)/i);
    const description = descMatch ? descMatch[1].trim() : null;
    
    const result = await executeRpc('generateProductImage', { productId, description, style, background });
    toolCalls.push({ method: 'generateProductImage', params: { productId, description, style, background }, result });
    
    if (result.success && result.data) {
      const imgData = result.data as { imageUrl: string; productName: string; productDetails: string; style: string; background: string; prompt: string; generatedAt: string; note: string };
      response = `🎨 **AI Product Image Generated!**\n\n` +
        `**Product:** ${imgData.productName}\n` +
        (imgData.productDetails ? `**Details:** ${imgData.productDetails}\n` : '') +
        `**Style:** ${imgData.style}\n` +
        `**Background:** ${imgData.background}\n\n` +
        `**Generated Prompt:**\n_"${imgData.prompt}"_\n\n` +
        `📸 **Preview:**\n![Generated Image](${imgData.imageUrl})\n\n` +
        `⏱️ Generated at: ${new Date(imgData.generatedAt).toLocaleTimeString()}\n\n` +
        `${imgData.note}`;
    } else {
      response = `❌ Failed to generate image: ${result.error}`;
    }
  }
  // === Product Success Analysis Intent ===
  else if ((message.includes('analy') && (message.includes('product') || message.includes('success'))) || 
           message.includes('product performance') || 
           message.includes('product success') ||
           (message.includes('how') && message.includes('product') && message.includes('doing')) ||
           (message.includes('cart') && message.includes('abandon')) ||
           (message.includes('conversion') && message.includes('product'))) {
    const productMatch = message.match(/product\s*#?(\d+)/i) || message.match(/for\s+#?(\d+)/i) || message.match(/#(\d+)/);
    
    if (!productMatch) {
      response = `🔍 **Product Success Analysis**\n\nTo analyze a product's performance, please specify a product ID:\n\n` +
        `• "Analyze product 749"\n` +
        `• "How is product #749 doing?"\n` +
        `• "Product 749 conversion analysis"\n\n` +
        `This will show you:\n` +
        `📊 Views, cart additions, abandonments & purchases\n` +
        `⭐ Review sentiment analysis\n` +
        `🤖 AI-powered success insights`;
    } else {
      const productId = parseInt(productMatch[1]);
      const result = await executeRpc('analyzeProductSuccess', { productId });
      toolCalls.push({ method: 'analyzeProductSuccess', params: { productId }, result });
      
      if (result.success && result.data) {
        const analysis = result.data as {
          productId: number;
          productName: string;
          productPrice: number;
          metrics: { views: number; addedToCart: number; abandonedInCart: number; purchased: number; viewedNotAdded: number };
          rates: { viewToCartRate: string; cartConversionRate: string; abandonmentRate: string; overallConversionRate: string };
          reviews: { count: number; averageRating: string; positive: number; neutral: number; negative: number; recentReviews: { title: string; rating: number; preview: string }[] };
          aiAnalysis: { successScore: number; successTier: string; insights: string[]; recommendation: string };
          analyzedAt: string;
        };
        
        const scoreEmoji = analysis.aiAnalysis.successScore >= 80 ? '🏆' : analysis.aiAnalysis.successScore >= 60 ? '✅' : analysis.aiAnalysis.successScore >= 40 ? '⚠️' : '🔴';
        
        response = `🔍 **Product Success Analysis**\n\n` +
          `**${analysis.productName}** (ID: ${analysis.productId})\n` +
          `💰 Price: $${analysis.productPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\n` +
          `---\n\n` +
          `${scoreEmoji} **Success Score: ${analysis.aiAnalysis.successScore}/100** (${analysis.aiAnalysis.successTier})\n\n` +
          `---\n\n` +
          `📊 **Engagement Metrics**\n` +
          `• **Views:** ${analysis.metrics.views.toLocaleString()}\n` +
          `• **Added to Cart:** ${analysis.metrics.addedToCart.toLocaleString()} (${analysis.rates.viewToCartRate}% of views)\n` +
          `• **Abandoned in Cart:** ${analysis.metrics.abandonedInCart.toLocaleString()} (${analysis.rates.abandonmentRate}%)\n` +
          `• **Purchased:** ${analysis.metrics.purchased.toLocaleString()} (${analysis.rates.overallConversionRate}% conversion)\n` +
          `• **Viewed but not added:** ${analysis.metrics.viewedNotAdded.toLocaleString()}\n\n` +
          `---\n\n` +
          `⭐ **Reviews** (${analysis.reviews.count} total, avg ${analysis.reviews.averageRating}★)\n` +
          `• 👍 Positive: ${analysis.reviews.positive} • 😐 Neutral: ${analysis.reviews.neutral} • 👎 Negative: ${analysis.reviews.negative}\n` +
          (analysis.reviews.recentReviews.length > 0 
            ? `\n**Recent Reviews:**\n` + analysis.reviews.recentReviews.map(r => `  • ${r.rating}★ "${r.title}" - ${r.preview}`).join('\n')
            : '') +
          `\n\n---\n\n` +
          `🤖 **AI Insights**\n` +
          analysis.aiAnalysis.insights.map(i => `• ${i}`).join('\n') +
          `\n\n💡 **Recommendation:** ${analysis.aiAnalysis.recommendation}\n\n` +
          `_Analysis generated at ${new Date(analysis.analyzedAt).toLocaleTimeString()}_`;
      } else {
        response = `❌ Failed to analyze product: ${result.error}`;
      }
    }
  }
  else {
    // Default: show stats as a starting point
    const result = await executeRpc('getStats');
    toolCalls.push({ method: 'getStats', params: {}, result });
    response = `I'm not sure what you're looking for. Here's what I can help with:\n\n` +
      `• **"Show me the stats"** - Business overview\n` +
      `• **"Top customers"** - Best spenders\n` +
      `• **"Pending orders"** - Orders needing attention\n` +
      `• **"Order #70001"** - Look up an order\n` +
      `• **"Customer 1001"** - Customer details\n` +
      `• **"Create order for customer 1001"** - New order\n` +
      `• **"Generate product image"** - AI image creation\n` +
      `• **"Analyze product 749"** - AI success analysis\n` +
      `• **"Generate sales report"** - Sales breakdown\n` +
      `• **"Help"** - See all commands`;
  }

  return {
    role: 'assistant',
    content: response,
    toolCalls,
  };
}
