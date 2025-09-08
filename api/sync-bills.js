// /api/sync-bills.js
// Sync Webflow CMS bill items with LegiScan data

export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = "68b8b074ed73a91391908240"; // Bills collection ID

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'Missing environment variables',
        message: 'WEBFLOW_API_TOKEN and LEGISCAN_API_KEY required',
      });
    }

    const results = {
      timestamp: new Date().toISOString(),
      processed: 0,
      updated: 0,
      skipped: 0,
      skipReasons: [],
      errors: [],
      bills: [],
    };

    // 1) Fetch items from Webflow
    const billsResponse = await fetch(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`,
      { headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` } }
    );
    if (!billsResponse.ok) {
      throw new Error(`Webflow API error: ${billsResponse.status}`);
    }

    const billsData = await billsResponse.json();
    const bills = billsData.items || [];

    // Helpers
    const STATUS_MAP = {
      1: 'Active', // Introduced
      2: 'Active', // Engrossed
      3: 'Active', // Enrolled
      4: 'Passed', // Passed
      5: 'Failed', // Vetoed
      6: 'Failed', // Dead
    };

    const isPlaceholderName = (name, billNum) => {
      const n = (name || '').trim();
      if (!n) return true;
      if (billNum && n.toUpperCase() === billNum.toUpperCase()) return true;
      if (/^[HS]F[-\s]?\d+$/i.test(n)) return true; // "HF1099", "SF 123"
      if (/^(untitled|tbd|placeholder)$/i.test(n)) return true;
      return false;
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 2) Process each item
    for (const bill of bills) {
      results.processed++;

      const houseNumber = bill.fieldData['house-file-number']?.trim();
      const senateNumber = bill.fieldData['senate-file-number']?.trim();
      const currentName = bill.fieldData['name']?.trim() || '';
      const jurisdiction = bill.fieldData['jurisdiction']?.trim() || '';
      const legislativeYear = bill.fieldData['legislative-year']?.toString().trim();

      const billNumber = houseNumber || senateNumber;
      if (!billNumber) {
        results.skipped++;
        results.skipReasons.push({ id: bill.id, reason: 'No HF/SF number' });
        continue;
      }

      // Default MN unless explicitly Federal
      const state = /^federal$/i.test(jurisdiction) ? 'US' : 'MN';

      try {
        // 3) LegiScan lookup
        let apiUrl = `https://api.legiscan.com/?key=${encodeURIComponent(
          LEGISCAN_API_KEY
        )}&op=getBill&state=${encodeURIComponent(state)}&bill=${encodeURIComponent(billNumber)}`;
        if (legislativeYear) apiUrl += `&year=${encodeURIComponent(legislativeYear)}`;

        const legiscanResponse = await fetch(apiUrl);
        const legiscanData = await legiscanResponse.json();

        if (legiscanData.status !== 'OK' || !legiscanData.bill) {
          results.errors.push({
            billId: bill.id,
            billNumber,
            error: legiscanData.alert?.message || 'Bill not found in LegiScan',
          });
          continue;
        }

        const billInfo = legiscanData.bill;

        // 4) Build update payload
        const updateData = { fieldData: {} };

        // Only overwrite name if it's a placeholder
        if (isPlaceholderName(currentName, billNumber)) {
          updateData.fieldData['name'] = billInfo.title || billNumber;
        }

        // Always refresh description + status
        updateData.fieldData['description'] =
          billInfo.description || billInfo.title || 'No description available';

        if (billInfo.status && STATUS_MAP[billInfo.status]) {
          updateData.fieldData['bill-status'] = STATUS_MAP[billInfo.status];
        }

        // Nothing to change? Skip.
        if (Object.keys(updateData.fieldData).length === 0) {
          results.skipped++;
          results.skipReasons.push({ id: bill.id, reason: 'No changes to apply' });
          continue;
        }

        // 5) Patch Webflow
        const updateResponse = await fetch(
          `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${bill.id}`,
          {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${WEBFLOW_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(updateData),
          }
        );

        if (updateResponse.ok) {
          results.updated++;
          results.bills.push({
            id: bill.id,
            billNumber,
            headline: updateData.fieldData.name || currentName,
            status: 'updated',
          });
        } else {
          const errorData = await updateResponse.json().catch(() => ({}));
          results.errors.push({
            billId: bill.id,
            billNumber,
            error: `Webflow update failed: ${errorData.message || updateResponse.statusText}`,
          });
        }

        // Rate-limit safety
        await sleep(500);
      } catch (err) {
        results.errors.push({ billId: bill.id, billNumber, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      summary: {
        totalBills: bills.length,
        processed: results.processed,
        updated: results.updated,
        skipped: results.skipped,
        errors: results.errors.length,
      },
      updatedBills: results.bills,
      skipReasons: results.skipReasons.length ? results.skipReasons : undefined,
      errors: results.errors.length ? results.errors : undefined,
    });
  } catch (error) {
    console.error('Sync failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Bills sync failed',
    });
  }
}
