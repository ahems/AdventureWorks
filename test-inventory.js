// Quick test of inventory integration
const API_URL = 'https://todoapp-api-ewphuc52etkbc.agreeableocean-5dff8db3.eastus2.azurecontainerapps.io/graphql/';

const query = `
  query TestInventory {
    prod928: productInventories(filter: { ProductID: { eq: 928 } }) {
      items { ProductID Quantity }
    }
    prod680: productInventories(filter: { ProductID: { eq: 680 } }) {
      items { ProductID Quantity }
    }
  }
`;

fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query })
})
  .then(res => res.json())
  .then(data => {
    const inv928 = data.data.prod928.items;
    const inv680 = data.data.prod680.items;
    
    const total928 = inv928.reduce((sum, item) => sum + item.Quantity, 0);
    const total680 = inv680.reduce((sum, item) => sum + item.Quantity, 0);
    
    console.log('Product 928 (HL Mountain Tire):');
    console.log(`  Inventory records: ${inv928.length}`);
    console.log(`  Total quantity: ${total928}`);
    console.log(`  Status: ${total928 > 0 ? '✅ IN STOCK' : '❌ OUT OF STOCK'}`);
    
    console.log('\nProduct 680 (HL Road Frame):');
    console.log(`  Inventory records: ${inv680.length}`);
    console.log(`  Total quantity: ${total680}`);
    console.log(`  Status: ${total680 > 0 ? '✅ IN STOCK' : '❌ OUT OF STOCK'}`);
    
    console.log('\n✅ Inventory integration test completed!');
  })
  .catch(err => console.error('❌ Error:', err));
