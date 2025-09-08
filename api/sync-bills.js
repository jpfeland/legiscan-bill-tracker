// /api/sync-bills.js
export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = "68b8b074ed73a91391908240";

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY) {
      return res.status(400).json({ success: false, error: "Missing env vars" });
    }

    const results = { timestamp: new Date().toISOString(), processed: 0, updated: 0, skipped: 0, skipReasons: [], errors: [], bills: [] };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const STATUS_MAP = { 1: "Active", 2: "Active", 3: "Active", 4: "Passed", 5: "Failed", 6: "Failed" };

    const isPlaceholderName = (name, billNum) => {
      const n = (name || "").trim();
      return (
        !n ||
        (billNum && n.toUpperCase() === billNum.toUpperCase()) ||
        /^[HS]F[-\s]?\d+$/i.test(n) ||
        /^(untitled|tbd|placeholder)$/i.test(n)
      );
    };

    async function fetchLegiScanBill({ state, billNumber, year }) {
      let url = `https://api.legiscan.com/?key=${encodeURIComponent(LEGISCAN_API_KEY)}&op=getBill&state=${encodeURIComponent(state)}&bill=${encodeURIComponent(billNumber)}`;
      if (year) url += `&year=${encodeURIComponent(year)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.status !== "OK" || !data.bill) throw new Error(data.alert?.message || "Bill not found");
      return data.bill;
    }

    function pickBestTextUrl(info) {
      if (!info) return null;
      const texts = Array.isArray(info.texts) ? info.texts.slice() : [];
      if (texts.length) {
        texts.sort((a, b) => new Date(b.date) - new Date(a.date));
        const pdf = texts.find((t) => /pdf/i.test(t?.mime || "") || /\.pdf($|\?)/i.test(t?.url || ""));
        if (pdf) return pdf.url || pdf.state_link || null;
        const first = texts[0];
        if (first) return first.url || first.state_link || null;
      }
      return info.state_link || info.url || null;
    }

    async function patchItem(itemId, data, { live } = {}) {
      const url = new URL(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`);
      if (live) url.searchParams.set("live", "true");
      return fetch(url.toString(), {
        method: "PATCH",
        headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }

    // fetch items
    const listRes = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
      headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` },
    });
    if (!listRes.ok) throw new Error(`Webflow API error: ${listRes.status}`);
    const bills = (await listRes.json()).items || [];

    for (const bill of bills) {
      results.processed++;

      const houseNumber = bill.fieldData["house-file-number"]?.trim();
      const senateNumber = bill.fieldData["senate-file-number"]?.trim();
      const currentName = bill.fieldData["name"]?.trim() || "";
      const jurisdiction = bill.fieldData["jurisdiction"]?.trim() || "";
      const legislativeYear = bill.fieldData["legislative-year"]?.toString().trim();

      if (!houseNumber && !senateNumber) {
        results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No HF/SF number" }); continue;
      }

      const state = /^federal$/i.test(jurisdiction) ? "US" : "MN";

      try {
        const primaryNumber = houseNumber || senateNumber;
        const primaryInfo = await fetchLegiScanBill({ state, billNumber: primaryNumber, year: legislativeYear });

        let houseInfo = null, senateInfo = null;
        if (houseNumber) houseInfo = primaryNumber === houseNumber ? primaryInfo : await (sleep(200), fetchLegiScanBill({ state, billNumber: houseNumber, year: legislativeYear }));
        if (senateNumber) senateInfo = primaryNumber === senateNumber ? primaryInfo : await (sleep(200), fetchLegiScanBill({ state, billNumber: senateNumber, year: legislativeYear }));

        const updateData = { fieldData: {} };
        if (isPlaceholderName(currentName, primaryNumber)) updateData.fieldData["name"] = primaryInfo.title || primaryNumber;
        updateData.fieldData["description"] = primaryInfo.description || primaryInfo.title || "No description available";
        if (primaryInfo.status && STATUS_MAP[primaryInfo.status]) updateData.fieldData["bill-status"] = STATUS_MAP[primaryInfo.status];

        const houseLink = pickBestTextUrl(houseInfo);
        const senateLink = pickBestTextUrl(senateInfo);
        if (houseLink)  updateData.fieldData["house-file-link"]  = houseLink;
        if (senateLink) updateData.fieldData["senate-file-link"] = senateLink;

        if (!Object.keys(updateData.fieldData).length) {
          results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No changes to apply" }); continue;
        }

        // Update both environments:
        const staging = await patchItem(bill.id, updateData, { live: false }); // Designer/Editor data
        if (!staging.ok) {
          const e = await staging.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Staging update failed: ${e.message || staging.statusText}` });
          continue;
        }

        await sleep(200);
        const live = await patchItem(bill.id, updateData, { live: true }); // Published site
        if (!live.ok) {
          const e = await live.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Live update failed: ${e.message || live.statusText}` });
          continue;
        }

        results.updated++;
        results.bills.push({ id: bill.id, houseNumber, senateNumber, headline: updateData.fieldData.name || currentName, status: "updated" });
        await sleep(300);
      } catch (err) {
        results.errors.push({ billId: bill.id, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      summary: { totalBills: bills.length, processed: results.processed, updated: results.updated, skipped: results.skipped, errors: results.errors.length },
      updatedBills: results.bills,
      skipReasons: results.skipReasons.length ? results.skipReasons : undefined,
      errors: results.errors.length ? results.errors : undefined,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message, message: "Bills sync failed" });
  }
}
