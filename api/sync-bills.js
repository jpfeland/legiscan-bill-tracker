// /api/sync-bills.js
// Sync bills from Webflow CMS with LegiScan API data

export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = "68b8b074ed73a91391908240"; // Bills collection ID

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY) {
      return res.status(400).json({
        error: 'Missing environment variables',
        message: 'WEBFLOW_API_TOKEN and LEGISCAN_API_KEY required'
      });
    }

    const results = {
      timestamp: new Date().toISOString(),
      processed: 0,
      updated: 0,
      errors: [],
      bills: []
    };

    // Step 1: Get all bills from Webflow
    console.log('Fetching bills from Webflow...');
    const billsResponse = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
      headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` }
    });

    if (!billsResponse.ok) {
      throw new Error(`Webflow API error: ${billsResponse.status}`);
    }

    const billsData = await billsResponse.json();
    const bills = billsData.items || [];

    // Step 2: Process each bill that needs sync
    for (const bill of bills) {
      results.processed++;
      
      // Check if bill needs syncing (has bill number but missing headline)
      const houseNumber = bill.fieldData['house-file-number'];
      const senateNumber = bill.fieldData['senate-file-number'];
      const currentHeadline = bill.fieldData['name'];
      const jurisdiction = bill.fieldData['jurisdiction'];
      const legislativeYear = bill.fieldData['legislative-year'];

      // Skip if no bill numbers or already has headline
      if ((!houseNumber && !senateNumber) || currentHeadline) {
        continue;
      }

      // Determine which bill number to use for lookup
      const billNumber = houseNumber || senateNumber;
      const state = jurisdiction === 'Federal' ? 'US' : 'MN';

      try {
        // Step 3: Get bill data from LegiScan
        console.log(`Looking up ${billNumber} in ${state} for year ${legislativeYear || 'current'}...`);
        
        // Build API URL with optional year parameter
        let apiUrl = `https://api.legiscan.com/?key=${LEGISCAN_API_KEY}&op=getBill&state=${state}&bill=${billNumber}`;
        if (legislativeYear) {
          apiUrl += `&year=${legislativeYear}`;
        }
        
        const legiscanResponse = await fetch(apiUrl);
        const legiscanData = await legiscanResponse.json();

        if (legiscanData.status !== 'OK') {
          results.errors.push({
            billId: bill.id,
            billNumber: billNumber,
            error: legiscanData.alert?.message || 'Bill not found in LegiScan'
          });
          continue;
        }

        const billInfo = legiscanData.bill;

        // Step 4: Prepare update data
        const updateData = {
          fieldData: {
            // Update headline with bill title
            'name': billInfo.title || billNumber,
            // Update description with bill description
            'description': billInfo.description || billInfo.title || 'No description available',
          }
        };

        // Map LegiScan status to Webflow status options
        const statusMapping = {
          1: 'Active',      // Introduced
          2: 'Active',      // Engrossed  
          3: 'Active',      // Enrolled
          4: 'Passed',      // Passed
          5: 'Failed',      // Vetoed
          6: 'Failed'       // Failed/Dead
        };

        if (billInfo.status && statusMapping[billInfo.status]) {
          updateData.fieldData['bill-status'] = statusMapping[billInfo.status];
        }

        // Step 5: Update bill in Webflow
        console.log(`Updating bill ${bill.id} with LegiScan data...`);
        const updateResponse = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${bill.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        });

        if (updateResponse.ok) {
          results.updated++;
          results.bills.push({
            id: bill.id,
            billNumber: billNumber,
            headline: updateData.fieldData.name,
            status: 'updated'
          });
        } else {
          const errorData = await updateResponse.json();
          results.errors.push({
            billId: bill.id,
            billNumber: billNumber,
            error: `Webflow update failed: ${errorData.message || updateResponse.statusText}`
          });
        }

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (error) {
        results.errors.push({
          billId: bill.id,
          billNumber: billNumber,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      summary: {
        totalBills: bills.length,
        processed: results.processed,
        updated: results.updated,
        errors: results.errors.length
      },
      updatedBills: results.bills,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (error) {
    console.error('Sync failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Bills sync failed'
    });
  }
}
