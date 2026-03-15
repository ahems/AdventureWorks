import React, { useState, useEffect } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Search, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowRight, FileText, Download, RefreshCw, Loader2, Eye, Mail } from 'lucide-react';
import AdminHeader from '@/components/AdminHeader';
import Footer from '@/components/Footer';
import { useAuth } from '@/context/AuthContext';
import { 
  mockOrders, 
  getCustomerById, 
  OrderStatus, 
  ORDER_STATUS_WORKFLOW, 
  ORDER_STATUS_CONFIG,
  Order 
} from '@/data/mockCustomers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { regenerateReceipt, triggerReceiptDownload, generateReceiptData, ReceiptData } from '@/services/mockReceiptService';
import ReceiptPreviewModal from '@/components/ReceiptPreviewModal';
import EmailReceiptDialog from '@/components/EmailReceiptDialog';

const ORDER_STATUS_STORAGE_KEY = 'aw_order_statuses';

const OrdersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [searchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [orderStatuses, setOrderStatuses] = useState<Record<number, OrderStatus>>({});
  const [regeneratingOrderId, setRegeneratingOrderId] = useState<number | null>(null);
  const [downloadingOrderId, setDownloadingOrderId] = useState<number | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewReceiptData, setPreviewReceiptData] = useState<ReceiptData | null>(null);
  const [previewOrder, setPreviewOrder] = useState<Order | null>(null);
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  const [emailReceiptData, setEmailReceiptData] = useState<ReceiptData | null>(null);
  const itemsPerPage = 10;

  // Load saved statuses from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(ORDER_STATUS_STORAGE_KEY);
    if (saved) {
      setOrderStatuses(JSON.parse(saved));
    }
  }, []);

  // Auto-expand order if orderId is in URL params
  useEffect(() => {
    const orderIdParam = searchParams.get('orderId');
    if (orderIdParam) {
      const orderId = parseInt(orderIdParam, 10);
      if (!isNaN(orderId)) {
        setExpandedOrderId(orderId);
        // Find which page the order is on
        const orderIndex = mockOrders.findIndex(o => o.SalesOrderID === orderId);
        if (orderIndex !== -1) {
          const page = Math.floor(orderIndex / itemsPerPage) + 1;
          setCurrentPage(page);
        }
      }
    }
  }, [searchParams]);

  // Get effective status (from localStorage or original)
  const getOrderStatus = (order: Order): OrderStatus => {
    return orderStatuses[order.SalesOrderID] || order.Status;
  };

  // Update order status
  const updateOrderStatus = (orderId: number, newStatus: OrderStatus) => {
    const newStatuses = { ...orderStatuses, [orderId]: newStatus };
    setOrderStatuses(newStatuses);
    localStorage.setItem(ORDER_STATUS_STORAGE_KEY, JSON.stringify(newStatuses));
    
    const config = ORDER_STATUS_CONFIG[newStatus];
    toast({
      title: `Order #${orderId} Updated`,
      description: `Status changed to ${config.icon} ${config.label}`,
    });
  };

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const ordersWithStatus = mockOrders.map(order => ({
    ...order,
    currentStatus: getOrderStatus(order),
  }));

  const filteredOrders = ordersWithStatus.filter(o => {
    const customer = getCustomerById(o.CustomerID);
    const matchesSearch = o.SalesOrderID.toString().includes(searchQuery) ||
      (customer && `${customer.FirstName} ${customer.LastName}`.toLowerCase().includes(searchQuery.toLowerCase()));
    const matchesStatus = statusFilter === 'all' || o.currentStatus === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const totalPages = Math.ceil(filteredOrders.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedOrders = filteredOrders.slice(startIndex, startIndex + itemsPerPage);

  const getStatusStyles = (status: OrderStatus) => {
    const config = ORDER_STATUS_CONFIG[status];
    return `${config.bgColor} ${config.color}`;
  };

  const toggleOrderExpand = (orderId: number) => {
    setExpandedOrderId(expandedOrderId === orderId ? null : orderId);
  };

  const handleRegenerateReceipt = async (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    setRegeneratingOrderId(order.SalesOrderID);
    try {
      const result = await regenerateReceipt(order.SalesOrderID);
      toast({
        title: 'Receipt Regenerated',
        description: result.message,
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to regenerate receipt',
        variant: 'destructive',
      });
    } finally {
      setRegeneratingOrderId(null);
    }
  };

  const handleDownloadReceipt = async (e: React.MouseEvent | null, order: Order) => {
    e?.stopPropagation();
    setDownloadingOrderId(order.SalesOrderID);
    try {
      await triggerReceiptDownload(order);
      toast({
        title: 'Download Started',
        description: `Receipt for order SO${order.SalesOrderID} is downloading.`,
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to download receipt. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setDownloadingOrderId(null);
    }
  };

  const handlePreviewReceipt = (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    const receiptData = generateReceiptData(order);
    setPreviewReceiptData(receiptData);
    setPreviewOrder(order);
    setPreviewModalOpen(true);
  };

  const handleDownloadFromPreview = () => {
    if (previewOrder) {
      handleDownloadReceipt(null, previewOrder);
    }
  };

  const handleEmailReceipt = (e: React.MouseEvent, order: Order) => {
    e.stopPropagation();
    const receiptData = generateReceiptData(order);
    setEmailReceiptData(receiptData);
    setEmailDialogOpen(true);
  };

  const handleSendEmail = async (email: string, subject: string, message: string) => {
    // Simulate sending email
    await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000));
    
    // 10% chance of simulated failure for realism
    if (Math.random() < 0.1) {
      toast({
        title: 'Email Failed',
        description: 'Failed to send email. Please try again.',
        variant: 'destructive',
      });
      throw new Error('Email send failed');
    }
    
    toast({
      title: 'Email Sent',
      description: `Receipt sent successfully to ${email}`,
    });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">

        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <h1 className="font-doodle text-3xl font-bold text-doodle-text mb-4">Order Management</h1>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  placeholder="Search by order # or customer..."
                  className="w-full pl-10 pr-4 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                />
              </div>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}>
                <SelectTrigger className="w-40 font-doodle"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="font-doodle">All Status</SelectItem>
                  {Object.entries(ORDER_STATUS_CONFIG).map(([status, config]) => (
                    <SelectItem key={status} value={status} className="font-doodle">
                      {config.icon} {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>

        <section className="container mx-auto px-4 pb-12">
          <div className="space-y-4">
            {paginatedOrders.map((order) => {
              const customer = getCustomerById(order.CustomerID);
              const statusConfig = ORDER_STATUS_CONFIG[order.currentStatus];
              const nextStatuses = ORDER_STATUS_WORKFLOW[order.currentStatus];
              const isExpanded = expandedOrderId === order.SalesOrderID;

              return (
                <div 
                  key={order.SalesOrderID} 
                  className="doodle-card overflow-hidden transition-all"
                >
                  {/* Order Header */}
                  <div 
                    className="p-4 cursor-pointer hover:bg-doodle-text/5 transition-colors"
                    onClick={() => toggleOrderExpand(order.SalesOrderID)}
                  >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex-1">
                          <div>
                          <div className="flex items-center gap-3">
                            <h3 className="font-doodle text-lg font-bold text-doodle-text">
                              Order #{order.SalesOrderID}
                            </h3>
                            <span className={`font-doodle text-xs px-2 py-1 border-2 border-current ${getStatusStyles(order.currentStatus)}`}>
                              {statusConfig.icon} {statusConfig.label}
                            </span>
                          </div>
                          <p className="font-doodle text-sm text-doodle-text/70 mt-1">
                            {customer ? `${customer.FirstName} ${customer.LastName}` : 'Unknown'} • {new Date(order.OrderDate).toLocaleDateString()}
                          </p>
                          <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                            {order.OrderItems.length} item(s)
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-doodle text-xl font-bold text-doodle-green">
                          ${order.TotalDue.toFixed(2)}
                        </p>
                        {isExpanded ? (
                          <ChevronUp className="w-5 h-5 text-doodle-text/50" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-doodle-text/50" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="border-t-2 border-dashed border-doodle-text/20 p-4 bg-doodle-text/5">
                      {/* Status Workflow */}
                      <div className="mb-6">
                        <h4 className="font-doodle font-bold text-doodle-text mb-3">Order Status Workflow</h4>
                        
                        {/* Visual Workflow Progress */}
                        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-2">
                          {(['Pending', 'Processing', 'Shipped', 'Delivered'] as OrderStatus[]).map((status, index) => {
                            const config = ORDER_STATUS_CONFIG[status];
                            const isCurrent = order.currentStatus === status;
                            const isPast = 
                              (order.currentStatus === 'Processing' && status === 'Pending') ||
                              (order.currentStatus === 'Shipped' && ['Pending', 'Processing'].includes(status)) ||
                              (order.currentStatus === 'Delivered' && ['Pending', 'Processing', 'Shipped'].includes(status));
                            const isCancelled = order.currentStatus === 'Cancelled';

                            return (
                              <React.Fragment key={status}>
                                <div 
                                  className={`flex flex-col items-center min-w-[80px] ${
                                    isCancelled ? 'opacity-30' : ''
                                  }`}
                                >
                                  <div 
                                    className={`w-10 h-10 rounded-full flex items-center justify-center text-lg border-2 ${
                                      isCurrent 
                                        ? `${config.bgColor} ${config.color} border-current` 
                                        : isPast
                                          ? 'bg-doodle-green/20 text-doodle-green border-doodle-green'
                                          : 'bg-doodle-text/10 text-doodle-text/40 border-doodle-text/20'
                                    }`}
                                  >
                                    {isPast ? '✓' : config.icon}
                                  </div>
                                  <span className={`font-doodle text-xs mt-1 ${
                                    isCurrent ? config.color : isPast ? 'text-doodle-green' : 'text-doodle-text/40'
                                  }`}>
                                    {config.label}
                                  </span>
                                </div>
                                {index < 3 && (
                                  <ArrowRight className={`w-4 h-4 flex-shrink-0 ${
                                    isCancelled ? 'opacity-30' : 
                                    isPast || (isCurrent && status !== 'Delivered') ? 'text-doodle-green' : 'text-doodle-text/20'
                                  }`} />
                                )}
                              </React.Fragment>
                            );
                          })}
                        </div>

                        {order.currentStatus === 'Cancelled' && (
                          <div className="flex items-center gap-2 p-3 bg-red-50 border-2 border-red-200 mb-4">
                            <span className="text-xl">❌</span>
                            <span className="font-doodle text-red-700">This order has been cancelled</span>
                          </div>
                        )}

                        {/* Status Actions */}
                        {nextStatuses.length > 0 && (
                          <div className="flex flex-wrap gap-2">
                            <span className="font-doodle text-sm text-doodle-text/60 self-center mr-2">
                              Change status to:
                            </span>
                            {nextStatuses.map((nextStatus) => {
                              const config = ORDER_STATUS_CONFIG[nextStatus];
                              return (
                                <button
                                  key={nextStatus}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    updateOrderStatus(order.SalesOrderID, nextStatus);
                                  }}
                                  className={`doodle-button text-sm py-2 px-4 flex items-center gap-2 ${
                                    nextStatus === 'Cancelled' 
                                      ? 'hover:bg-red-100 hover:text-red-700 hover:border-red-300'
                                      : 'doodle-button-primary'
                                  }`}
                                >
                                  {config.icon} {config.label}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {nextStatuses.length === 0 && (
                          <p className="font-doodle text-sm text-doodle-text/50 italic">
                            This order is in a final state and cannot be changed.
                          </p>
                        )}
                      </div>

                      {/* Order Items */}
                      <div className="mb-4">
                        <h4 className="font-doodle font-bold text-doodle-text mb-2">Order Items</h4>
                        <div className="space-y-2">
                          {order.OrderItems.map((item) => (
                            <div 
                              key={item.SalesOrderDetailID}
                              className="flex justify-between items-center p-2 bg-white border-2 border-dashed border-doodle-text/20"
                            >
                              <div>
                                <span className="font-doodle text-doodle-text">{item.ProductName}</span>
                                <span className="font-doodle text-xs text-doodle-text/50 ml-2">× {item.OrderQty}</span>
                              </div>
                              <span className="font-doodle font-bold text-doodle-text">
                                ${item.LineTotal.toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Order Summary */}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-3 bg-white border-2 border-doodle-text/20">
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">Subtotal</span>
                          <span className="font-doodle font-bold">${order.SubTotal.toFixed(2)}</span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">Tax</span>
                          <span className="font-doodle font-bold">${order.TaxAmt.toFixed(2)}</span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">Freight</span>
                          <span className="font-doodle font-bold">${order.Freight.toFixed(2)}</span>
                        </div>
                        <div>
                          <span className="font-doodle text-xs text-doodle-text/50 block">Total Due</span>
                          <span className="font-doodle font-bold text-doodle-green">${order.TotalDue.toFixed(2)}</span>
                        </div>
                      </div>

                      {/* Receipt Actions */}
                      <div className="mt-4 pt-4 border-t-2 border-dashed border-doodle-text/20">
                        <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                          <FileText className="w-4 h-4" />
                          Receipt Actions
                        </h4>
                        <div className="flex flex-wrap gap-3">
                          <button
                            onClick={(e) => handlePreviewReceipt(e, order)}
                            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
                          >
                            <Eye className="w-4 h-4" />
                            Preview Receipt
                          </button>
                          <button
                            onClick={(e) => handleRegenerateReceipt(e, order)}
                            disabled={regeneratingOrderId === order.SalesOrderID}
                            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
                          >
                            {regeneratingOrderId === order.SalesOrderID ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <RefreshCw className="w-4 h-4" />
                            )}
                            {regeneratingOrderId === order.SalesOrderID ? 'Regenerating...' : 'Regenerate Receipt'}
                          </button>
                          <button
                            onClick={(e) => handleDownloadReceipt(e, order)}
                            disabled={downloadingOrderId === order.SalesOrderID}
                            className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
                          >
                            {downloadingOrderId === order.SalesOrderID ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Download className="w-4 h-4" />
                            )}
                            {downloadingOrderId === order.SalesOrderID ? 'Downloading...' : 'Download Receipt'}
                          </button>
                          <button
                            onClick={(e) => handleEmailReceipt(e, order)}
                            className="doodle-button flex items-center gap-2 py-2 px-4 hover:bg-doodle-accent/10"
                          >
                            <Mail className="w-4 h-4" />
                            Email Receipt
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="doodle-card p-4 mt-6 flex items-center justify-center gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="p-2 disabled:opacity-40">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="font-doodle">Page {currentPage} of {totalPages}</span>
              <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="p-2 disabled:opacity-40">
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </section>
      </main>
      <Footer />

      <ReceiptPreviewModal
        open={previewModalOpen}
        onOpenChange={setPreviewModalOpen}
        receiptData={previewReceiptData}
        onDownload={handleDownloadFromPreview}
        isDownloading={downloadingOrderId === previewOrder?.SalesOrderID}
      />

      <EmailReceiptDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        receiptData={emailReceiptData}
        onSend={handleSendEmail}
      />

    </div>
  );
};

export default OrdersPage;
