// /api/sync-bills.js
// Sync Webflow CMS bill items with LegiScan data, incl. House/Senate file links

export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = "68b8b074ed73a91391908240"; // Bills collection ID

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY) {
      return res.status(400).json({
        success: false,
        error: "Missing environment variables",
        message: "WEBFLOW_API_TOKEN and LEGISCAN_API_KEY required",
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

    // --- helpers ------------------------------------------------------------

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const STATUS_MAP = {
      1: "Active", // Introduced
      2: "Active", // Engrossed
      3: "Active", // Enrolled
      4: "Passed", // Passed
      5: "Failed", // Vetoed
      6: "Failed", // Dead
    };

    // Only overwrite "name" if it's obviously a placeholder
    const isPlaceholderName = (name, billNum) => {
      const n = (name || "").trim();
      if (!n) return true;
      if (billNum && n.toUpperCase() === billNum.toUpperCase()) return true;
      if (/^[HS]F[-\s]?\d+$/i.test(n)) return true; // "HF1099", "SF 123"
      if (/^(untitled|tbd|placeholder)$/i.test(n)) return true;
      return false;
    };

    async function fetchLegiScanBill({ state, billNumber, year }) {
      let apiUrl = `https://api.legiscan.com/?key=${encodeURIComponent(
        LEGISCAN_API_KEY
      )}&op=getBill&state=${encodeURIComponent(
        state
      )}&bill=${encodeURIComponent(billNumber)}`;
      if (year) apiUrl += `&year=${encodeURIComponent(year)}`;

      const resp = await fetch(apiUrl);
      const data = await resp.json();
      if (data.status !== "OK" || !data.bill) {
        throw new Error(data.alert?.message || "Bill not found in LegiScan");
      }
      return data.bill;
    }

    // Prefer newest PDF text; else newest text link; else bill page/state link
    function pickBestTextUrl(billInfo) {
      if (!billInfo) return null;
      const texts = Array.isArray(billInfo.texts) ? billInfo.texts.slice() : [];
      if (texts.length) {
        texts.sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
        const pdf = texts.find(
          (t) => /pdf/i.test(t?.mime || "") || /\.pdf($|\?)/i.test(t?.url || "")
        );
        if (pdf) return pdf.url || pdf.state_link || null;
        const first = texts[0];
        if (first) return first.url || first.state_link || null;
      }
      return billInfo.state_link || billInfo.url || null;
    }

    // --- fetch Webflow items -----------------------------------------------

    const billsResponse = await fetch(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`,
      { headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` } }
    );
    if (!billsResponse.ok) throw new Error(`Webflow API error: ${billsResponse.status}`);

    const billsData = await billsResponse.json();
    const bills = billsData.items || [];

    // --- process ------------------------------------------------------------

    for (const bill of bills) {
      results.processed++;

      const houseNumber = bill.fieldData["house-file-number"]?.trim();
      const senateNumber = bill.fieldData["senate-file-number"]?.trim();
      const currentName = bill.fieldData["name"]?.trim() || "";
      const jurisdiction = bill.fieldData["jurisdiction"]?.trim() || "";
      const legislativeYear = bill.fieldData["legislative-year"]?.toString().trim();

      if (!houseNumber && !senateNumber) {
        results.skipped++;
        results.skipReasons.push({ id: bill.id, reason: "No HF/SF number" });
        continue;
      }

      const state = /^federal$/i.test(jurisdiction) ? "US" : "MN";

      try {
        const primaryNumber = houseNumber || senateNumber;

        const primaryInfo = await fetchLegiScanBill({
          state,
          billNumber: primaryNumber,
          year: legislativeYear,
        });

        let houseInfo = null;
        let senateInfo = null;

        if (houseNumber) {
          houseInfo =
            primaryNumber === houseNumber
              ? primaryInfo
              : await (sleep(200), fetchLegiScanBill({ state, billNumber: houseNumber, year: legislativeYear }));
        }

        if (senateNumber) {
          senateInfo =
            primaryNumber === senateNumber
              ? primaryInfo
              : await (sleep(200), fetchLegiScanBill({ state, billNumber: senateNumber, year: legislativeYear }));
        }

        const updateData = { fieldData: {} };

        // Headline
        if (isPlaceholderName(currentName, primaryNumber)) {
          updateData.fieldData["name"] = primaryInfo.title || primaryNumber;
        }

        // Description
        updateData.fieldData["description"] =
          primaryInfo.description || primaryInfo.title || "No description available";

        // Status
        if (primaryInfo.status && STATUS_MAP[primaryInfo.status]) {
          updateData.fieldData["bill-status"] = STATUS_MAP[primaryInfo.status];
        }

        // Links (your updated slugs)
        const houseLink = pickBestTextUrl(houseInfo);
        const senateLink = pickBestTextUrl(senateInfo);
        if (houseLink) updateData.fieldData["house-file-link"] = houseLink;
        if (senateLink) updateData.fieldData["senate-file-link"] = senateLink;

        if (Object.keys(updateData.fieldData).length === 0) {
          results.skipped++;
          results.skipReasons.push({ id: bill.id, reason: "No changes to apply" });
          continue;
        }

        const updateResponse = await fetch(
          `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${bill.id}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${WEBFLOW_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(updateData),
          }
        );

        if (updateResponse.ok) {
          results.updated++;
          results.bills.push({
            id: bill.id,
            houseNumber,
            senateNumber,
            headline: updateData.fieldData.name || currentName,
            status: "updated",
          });
        } else {
          const errorData = await updateResponse.json().catch(() => ({}));
          results.errors.push({
            billId: bill.id,
            error: `Webflow update failed: ${errorData.message || updateResponse.statusText}`,
          });
        }

        await sleep(350);
      } catch (err) {
        results.errors.push({ billId: bill.id, error: err.message });
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
    console.error("Sync failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: "Bills sync failed",
    });
  }
}
