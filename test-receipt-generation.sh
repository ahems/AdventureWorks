#!/bin/bash

# Test script for Order Receipt PDF Generation
# This script helps test the receipt generation function locally

echo "========================================"
echo "Order Receipt PDF Generation Test Script"
echo "========================================"
echo ""

# Check if the function is running
FUNCTION_URL="${1:-http://localhost:7071}"
ENDPOINT="${FUNCTION_URL}/api/GenerateOrderReceipts_HttpStart"

echo "Testing endpoint: $ENDPOINT"
echo ""

# Test 1: Generate receipt for a single order
echo "Test 1: Generating receipt for a single order..."
echo "Request: SO43659"
echo ""

RESPONSE=$(curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659"]}')

echo "Response:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
echo ""
echo "----------------------------------------"
echo ""

# Test 2: Generate receipts for multiple orders
echo "Test 2: Generating receipts for multiple orders..."
echo "Request: SO43659, SO43660, SO43661"
echo ""

RESPONSE=$(curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": ["SO43659", "SO43660", "SO43661"]}')

echo "Response:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
echo ""
echo "----------------------------------------"
echo ""

# Test 3: Invalid request (empty array)
echo "Test 3: Testing error handling (empty array)..."
echo ""

RESPONSE=$(curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"salesOrderNumbers": []}')

echo "Response:"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
echo ""
echo "----------------------------------------"
echo ""

# Instructions for checking results
echo "📝 How to verify the receipts were generated:"
echo ""
echo "1. Check the Azure Functions logs for processing messages"
echo "2. Look for messages like:"
echo "   - 'Enqueued receipt generation for order: SO43659'"
echo "   - 'Processing receipt generation for order: SO43659'"
echo "   - 'Successfully generated receipt for order SO43659'"
echo ""
echo "3. Check blob storage for the generated PDFs:"
echo "   Container: adventureworks-receipts"
echo "   Folder: CustomerReceipts/"
echo "   Files: SO43659.pdf, SO43660.pdf, etc."
echo ""
echo "4. You can also use Azure Storage Explorer or the Azure Portal"
echo "   to view the generated PDFs"
echo ""
echo "========================================"
echo "Test Complete!"
echo "========================================"
