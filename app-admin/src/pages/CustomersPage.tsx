import React, { useState, useEffect, useMemo } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Search, ChevronLeft, ChevronRight, Mail, Phone, MapPin, Edit2, Save, X, ChevronDown, ChevronUp, User, ShoppingBag, ExternalLink, Filter, BarChart3, Globe, Sparkles, CheckSquare, Square } from 'lucide-react';
import AdminHeader from '@/components/AdminHeader';
import Footer from '@/components/Footer';
import { useAuth } from '@/context/AuthContext';
import { mockCustomers, Customer, mockOrders, ORDER_STATUS_CONFIG } from '@/data/mockCustomers';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import CustomerStatsDashboard from '@/components/CustomerStatsDashboard';
import CountryFlag from '@/components/CountryFlag';
import CustomerCountryMap from '@/components/CustomerCountryMap';
import { Checkbox } from '@/components/ui/checkbox';
import BulkAiEmailDialog from '@/components/BulkAiEmailDialog';

const STORAGE_KEY = 'adventureworks_customers';

const CustomersPage: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [cityFilter, setCityFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [spentFilter, setSpentFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedCustomerId, setExpandedCustomerId] = useState<number | null>(null);
  const [editingCustomerId, setEditingCustomerId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<Customer[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : mockCustomers;
  });
  const [editForm, setEditForm] = useState<Partial<Customer>>({});
  const [showStats, setShowStats] = useState(true);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<number>>(new Set());
  const [bulkEmailDialogOpen, setBulkEmailDialogOpen] = useState(false);
  const itemsPerPage = 10;

  // Extract unique cities and states for filter options
  const uniqueCities = useMemo(() => 
    [...new Set(customers.map(c => c.City))].sort(), [customers]);
  const uniqueStates = useMemo(() => 
    [...new Set(customers.map(c => c.StateProvince))].sort(), [customers]);
  const uniqueCountries = useMemo(() => 
    [...new Set(customers.map(c => c.Country))].sort(), [customers]);

  const spentRanges = [
    { value: 'all', label: 'All Amounts' },
    { value: '0-1000', label: 'Under $1,000' },
    { value: '1000-5000', label: '$1,000 - $5,000' },
    { value: '5000-10000', label: '$5,000 - $10,000' },
    { value: '10000+', label: 'Over $10,000' },
  ];

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customers));
  }, [customers]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  const filteredCustomers = customers.filter(c => {
    const matchesSearch = 
      c.FirstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.LastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.EmailAddress.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.Country.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesCity = cityFilter === 'all' || c.City === cityFilter;
    const matchesState = stateFilter === 'all' || c.StateProvince === stateFilter;
    const matchesCountry = countryFilter === 'all' || c.Country === countryFilter;
    
    let matchesSpent = true;
    if (spentFilter === '0-1000') matchesSpent = c.TotalSpent < 1000;
    else if (spentFilter === '1000-5000') matchesSpent = c.TotalSpent >= 1000 && c.TotalSpent < 5000;
    else if (spentFilter === '5000-10000') matchesSpent = c.TotalSpent >= 5000 && c.TotalSpent < 10000;
    else if (spentFilter === '10000+') matchesSpent = c.TotalSpent >= 10000;
    
    return matchesSearch && matchesCity && matchesState && matchesCountry && matchesSpent;
  });

  const activeFiltersCount = [cityFilter, stateFilter, countryFilter, spentFilter].filter(f => f !== 'all').length;

  const clearAllFilters = () => {
    setCityFilter('all');
    setStateFilter('all');
    setCountryFilter('all');
    setSpentFilter('all');
    setSearchQuery('');
    setCurrentPage(1);
  };

  const totalPages = Math.ceil(filteredCustomers.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedCustomers = filteredCustomers.slice(startIndex, startIndex + itemsPerPage);

  const handleToggleExpand = (customerId: number) => {
    if (expandedCustomerId === customerId) {
      setExpandedCustomerId(null);
      setEditingCustomerId(null);
    } else {
      setExpandedCustomerId(customerId);
      setEditingCustomerId(null);
    }
  };

  const handleStartEdit = (customer: Customer) => {
    setEditingCustomerId(customer.CustomerID);
    setEditForm({
      FirstName: customer.FirstName,
      LastName: customer.LastName,
      EmailAddress: customer.EmailAddress,
      Phone: customer.Phone,
      AddressLine1: customer.AddressLine1,
      City: customer.City,
      StateProvince: customer.StateProvince,
      PostalCode: customer.PostalCode,
      Country: customer.Country,
    });
  };

  const handleCancelEdit = () => {
    setEditingCustomerId(null);
    setEditForm({});
  };

  const handleSaveEdit = (customerId: number) => {
    setCustomers(prev => prev.map(c => 
      c.CustomerID === customerId ? { ...c, ...editForm } : c
    ));
    setEditingCustomerId(null);
    setEditForm({});
    toast.success('Customer updated successfully');
  };

  const handleFormChange = (field: keyof Customer, value: string) => {
    setEditForm(prev => ({ ...prev, [field]: value }));
  };

  const toggleCustomerSelection = (e: React.MouseEvent, customerId: number) => {
    e.stopPropagation();
    setSelectedCustomerIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(customerId)) {
        newSet.delete(customerId);
      } else {
        newSet.add(customerId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedCustomerIds.size === paginatedCustomers.length) {
      setSelectedCustomerIds(new Set());
    } else {
      setSelectedCustomerIds(new Set(paginatedCustomers.map((c) => c.CustomerID)));
    }
  };

  const selectedCustomers = customers.filter((c) => selectedCustomerIds.has(c.CustomerID));

  const handleBulkEmailComplete = () => {
    setSelectedCustomerIds(new Set());
    toast.success('Bulk email campaign completed!');
  };

  return (
    <div className="min-h-screen flex flex-col">
      <AdminHeader />
      <main className="flex-1 pt-4">

        <section className="container mx-auto px-4 pb-8">
          <div className="doodle-card p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
              <h1 className="font-doodle text-3xl font-bold text-doodle-text">Customer Management</h1>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowStats(!showStats)}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 font-doodle text-sm border-2 rounded transition-colors ${
                    showStats 
                      ? 'bg-doodle-accent text-white border-doodle-text' 
                      : 'text-doodle-text border-doodle-text hover:bg-doodle-accent/10'
                  }`}
                >
                  <BarChart3 className="w-4 h-4" />
                  {showStats ? 'Hide Stats' : 'Show Stats'}
                </button>
                {activeFiltersCount > 0 && (
                  <button
                    onClick={clearAllFilters}
                    className="inline-flex items-center gap-2 px-3 py-1.5 font-doodle text-sm text-doodle-red hover:bg-doodle-red/10 border-2 border-doodle-red rounded transition-colors"
                  >
                    <X className="w-4 h-4" />
                    Clear {activeFiltersCount} filter{activeFiltersCount > 1 ? 's' : ''}
                  </button>
                )}
              </div>
            </div>
            
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-doodle-text/50" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  placeholder="Search customers..."
                  className="w-full pl-10 pr-4 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                />
              </div>
              
              <div className="flex flex-wrap gap-3 items-center">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-doodle-text/60" />
                  <span className="font-doodle text-sm text-doodle-text/60">Filters:</span>
                </div>
                
                <Select value={cityFilter} onValueChange={(v) => { setCityFilter(v); setCurrentPage(1); }}>
                  <SelectTrigger className="w-36 font-doodle">
                    <SelectValue placeholder="City" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">All Cities</SelectItem>
                    {uniqueCities.map(city => (
                      <SelectItem key={city} value={city} className="font-doodle">{city}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Select value={stateFilter} onValueChange={(v) => { setStateFilter(v); setCurrentPage(1); }}>
                  <SelectTrigger className="w-36 font-doodle">
                    <SelectValue placeholder="State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">All States</SelectItem>
                    {uniqueStates.map(state => (
                      <SelectItem key={state} value={state} className="font-doodle">{state}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Select value={countryFilter} onValueChange={(v) => { setCountryFilter(v); setCurrentPage(1); }}>
                  <SelectTrigger className="w-44 font-doodle">
                    <SelectValue placeholder="Country" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="font-doodle">All Countries</SelectItem>
                    {uniqueCountries.map(country => (
                      <SelectItem key={country} value={country} className="font-doodle">
                        <span className="flex items-center gap-2">
                          <CountryFlag country={country} /> {country}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <Select value={spentFilter} onValueChange={(v) => { setSpentFilter(v); setCurrentPage(1); }}>
                  <SelectTrigger className="w-44 font-doodle">
                    <SelectValue placeholder="Total Spent" />
                  </SelectTrigger>
                  <SelectContent>
                    {spentRanges.map(range => (
                      <SelectItem key={range.value} value={range.value} className="font-doodle">{range.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <p className="font-doodle text-sm text-doodle-text/60 mt-4">
              Showing {filteredCustomers.length} customer{filteredCustomers.length !== 1 ? 's' : ''}
            </p>
          </div>
        </section>

        {showStats && <CustomerStatsDashboard customers={customers} />}
        
        {showStats && <CustomerCountryMap customers={customers} />}

        <section className="container mx-auto px-4 pb-12">
          {/* Bulk Actions Bar */}
          <div className="doodle-card p-3 mb-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={toggleSelectAll}
                className="font-doodle text-sm flex items-center gap-2 hover:text-doodle-accent transition-colors"
              >
                {selectedCustomerIds.size === paginatedCustomers.length && paginatedCustomers.length > 0 ? (
                  <CheckSquare className="w-4 h-4" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                {selectedCustomerIds.size > 0 
                  ? `${selectedCustomerIds.size} selected` 
                  : 'Select all'}
              </button>
            </div>
            {selectedCustomerIds.size > 0 && (
              <button
                onClick={() => setBulkEmailDialogOpen(true)}
                className="doodle-button doodle-button-primary flex items-center gap-2 py-2 px-4"
              >
                <Sparkles className="w-4 h-4" />
                AI Email Campaign ({selectedCustomerIds.size})
              </button>
            )}
          </div>

          <div className="space-y-4">
            {paginatedCustomers.map((customer) => {
              const isExpanded = expandedCustomerId === customer.CustomerID;
              const isEditing = editingCustomerId === customer.CustomerID;
              const isSelected = selectedCustomerIds.has(customer.CustomerID);

              return (
                <div key={customer.CustomerID} className={`doodle-card overflow-hidden transition-all ${isSelected ? 'ring-2 ring-doodle-accent' : ''}`}>
                  <div 
                    className="p-4 cursor-pointer hover:bg-doodle-accent/5 transition-colors"
                    onClick={() => handleToggleExpand(customer.CustomerID)}
                  >
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => {}}
                          onClick={(e) => toggleCustomerSelection(e, customer.CustomerID)}
                          className="mt-1"
                        />
                        <div>
                        <h3 className="font-doodle text-lg font-bold text-doodle-text flex items-center gap-2">
                          <User className="w-5 h-5" />
                          {customer.FirstName} {customer.LastName}
                        </h3>
                        <div className="flex flex-wrap gap-4 mt-2 text-sm">
                          <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                            <Mail className="w-4 h-4" /> {customer.EmailAddress}
                          </span>
                          <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                            <Phone className="w-4 h-4" /> {customer.Phone}
                          </span>
                          <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                            <MapPin className="w-4 h-4" /> {customer.City}, {customer.StateProvince}
                          </span>
                          <span className="font-doodle text-doodle-text/70 flex items-center gap-1">
                            <CountryFlag country={customer.Country} /> {customer.Country}
                          </span>
                        </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="font-doodle text-sm text-doodle-text/60">{customer.TotalOrders} orders</p>
                          <p className="font-doodle font-bold text-doodle-green">${customer.TotalSpent.toFixed(2)}</p>
                        </div>
                        {isExpanded ? (
                          <ChevronUp className="w-5 h-5 text-doodle-text/50" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-doodle-text/50" />
                        )}
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t-2 border-doodle-text/10 p-4 bg-doodle-accent/5">
                      {isEditing ? (
                        <div className="space-y-6">
                          <div>
                            <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                              <User className="w-4 h-4" /> Contact Information
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">First Name</label>
                                <input
                                  type="text"
                                  value={editForm.FirstName || ''}
                                  onChange={(e) => handleFormChange('FirstName', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Last Name</label>
                                <input
                                  type="text"
                                  value={editForm.LastName || ''}
                                  onChange={(e) => handleFormChange('LastName', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Email Address</label>
                                <input
                                  type="email"
                                  value={editForm.EmailAddress || ''}
                                  onChange={(e) => handleFormChange('EmailAddress', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Phone</label>
                                <input
                                  type="tel"
                                  value={editForm.Phone || ''}
                                  onChange={(e) => handleFormChange('Phone', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                            </div>
                          </div>

                          <div>
                            <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                              <MapPin className="w-4 h-4" /> Address Information
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="md:col-span-2">
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Street Address</label>
                                <input
                                  type="text"
                                  value={editForm.AddressLine1 || ''}
                                  onChange={(e) => handleFormChange('AddressLine1', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">City</label>
                                <input
                                  type="text"
                                  value={editForm.City || ''}
                                  onChange={(e) => handleFormChange('City', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">State/Province</label>
                                <input
                                  type="text"
                                  value={editForm.StateProvince || ''}
                                  onChange={(e) => handleFormChange('StateProvince', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Postal Code</label>
                                <input
                                  type="text"
                                  value={editForm.PostalCode || ''}
                                  onChange={(e) => handleFormChange('PostalCode', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                              <div>
                                <label className="font-doodle text-sm text-doodle-text/70 block mb-1">Country</label>
                                <input
                                  type="text"
                                  value={editForm.Country || ''}
                                  onChange={(e) => handleFormChange('Country', e.target.value)}
                                  className="w-full px-3 py-2 font-doodle border-2 border-doodle-text bg-white focus:border-doodle-accent focus:outline-none"
                                />
                              </div>
                            </div>
                          </div>

                          <div className="flex gap-2 pt-2">
                            <button
                              onClick={() => handleSaveEdit(customer.CustomerID)}
                              className="doodle-btn flex items-center gap-2"
                            >
                              <Save className="w-4 h-4" /> Save Changes
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="px-4 py-2 font-doodle border-2 border-doodle-text hover:bg-doodle-text/10 transition-colors flex items-center gap-2"
                            >
                              <X className="w-4 h-4" /> Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          <div>
                            <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                              <User className="w-4 h-4" /> Contact Information
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Full Name</p>
                                <p className="font-doodle text-doodle-text">{customer.FirstName} {customer.LastName}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Email</p>
                                <p className="font-doodle text-doodle-text">{customer.EmailAddress}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Phone</p>
                                <p className="font-doodle text-doodle-text">{customer.Phone}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Customer Since</p>
                                <p className="font-doodle text-doodle-text">{new Date(customer.CreatedAt).toLocaleDateString()}</p>
                              </div>
                            </div>
                          </div>

                          <div>
                            <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                              <MapPin className="w-4 h-4" /> Address Information
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div className="md:col-span-2">
                                <p className="font-doodle text-sm text-doodle-text/60">Street Address</p>
                                <p className="font-doodle text-doodle-text">{customer.AddressLine1}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">City</p>
                                <p className="font-doodle text-doodle-text">{customer.City}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">State/Province</p>
                                <p className="font-doodle text-doodle-text">{customer.StateProvince}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Postal Code</p>
                                <p className="font-doodle text-doodle-text">{customer.PostalCode}</p>
                              </div>
                              <div>
                                <p className="font-doodle text-sm text-doodle-text/60">Country</p>
                                <p className="font-doodle text-doodle-text flex items-center gap-2">
                                  <CountryFlag country={customer.Country} /> {customer.Country}
                                </p>
                              </div>
                            </div>
                          </div>

                          {/* Order History Section */}
                          <div>
                            <h4 className="font-doodle font-bold text-doodle-text mb-3 flex items-center gap-2">
                              <ShoppingBag className="w-4 h-4" /> Order History
                            </h4>
                            {(() => {
                              const customerOrders = mockOrders.filter(o => o.CustomerID === customer.CustomerID);
                              if (customerOrders.length === 0) {
                                return (
                                  <p className="font-doodle text-doodle-text/60 text-sm">No orders found for this customer.</p>
                                );
                              }
                              return (
                                <div className="space-y-2">
                                  {customerOrders.map(order => {
                                    const statusConfig = ORDER_STATUS_CONFIG[order.Status];
                                    return (
                                      <Link
                                        key={order.SalesOrderID}
                                        to={`/orders?orderId=${order.SalesOrderID}`}
                                        onClick={(e) => e.stopPropagation()}
                                        className="block p-3 border-2 border-doodle-text/20 bg-white hover:border-doodle-accent transition-colors"
                                      >
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                          <div className="flex items-center gap-3">
                                            <span className="font-doodle font-bold text-doodle-text">
                                              #{order.SalesOrderID}
                                            </span>
                                            <span className={`px-2 py-0.5 text-xs font-doodle ${statusConfig.bgColor} ${statusConfig.color}`}>
                                              {statusConfig.icon} {statusConfig.label}
                                            </span>
                                          </div>
                                          <div className="flex items-center gap-4">
                                            <span className="font-doodle text-sm text-doodle-text/60">
                                              {new Date(order.OrderDate).toLocaleDateString()}
                                            </span>
                                            <span className="font-doodle font-bold text-doodle-green">
                                              ${order.TotalDue.toFixed(2)}
                                            </span>
                                            <ExternalLink className="w-4 h-4 text-doodle-accent" />
                                          </div>
                                        </div>
                                        <p className="font-doodle text-xs text-doodle-text/50 mt-1">
                                          {order.OrderItems.length} item{order.OrderItems.length !== 1 ? 's' : ''}: {order.OrderItems.map(i => i.ProductName).join(', ')}
                                        </p>
                                      </Link>
                                    );
                                  })}
                                </div>
                              );
                            })()}
                          </div>

                          <button
                            onClick={(e) => { e.stopPropagation(); handleStartEdit(customer); }}
                            className="doodle-btn flex items-center gap-2"
                          >
                            <Edit2 className="w-4 h-4" /> Edit Customer
                          </button>
                        </div>
                      )}
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
      
      <BulkAiEmailDialog
        open={bulkEmailDialogOpen}
        onOpenChange={setBulkEmailDialogOpen}
        selectedCustomers={selectedCustomers}
        onComplete={handleBulkEmailComplete}
      />
    </div>
  );
};

export default CustomersPage;