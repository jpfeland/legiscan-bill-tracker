// /api/sync-bills.js
// Sync Webflow CMS bill items with LegiScan data (no description edits)
// Auto-corrects misfiled HF/SF numbers and writes links to the right fields.

export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = "68b8b074ed73a91391908240";

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY) {
      return res.status(400).json({ success: false, error: "Missing env vars" });
    }

    const results = { timestamp: new Date().toISOString(), processed: 0, updated: 0, skipped: 0, skipReasons: [], errors: [], bills: [] };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const STATUS_MAP = { 1: "Active", 2: "Active", 3: "Active", 4: "Passed", 5: "Failed", 6: "Failed" };

    const isPlaceholderName = (name, billNum) => {
      const n = (name || "").trim();
      return !n || (billNum && n.toUpperCase() === billNum.toUpperCase()) || /^[HS]F[-\s]?\d+$/i.test(n) || /^(untitled|tbd|placeholder)$/i.test(n);
    };

    // Normalize "HF 1099" -> "HF1099", detect swaps (HF typed in Senate field, etc.)
    function normalizeNumbers(rawHouse, rawSenate) {
      const norm = v => (v || "").toUpperCase().replace(/[\s-]+/g, "");
      let h = norm(rawHouse);
      let s = norm(rawSenate);

      let corrections = {};
      // If senate has HF and house is empty -> move to house
      if (!h && /^HF\d+$/.test(s)) {
        h = s; s = "";
        corrections["house-file-number"] = h;
        corrections["senate-file-number"] = ""; // clear wrong entry
      }
      // If house has SF and senate is empty -> move to senate
      if (!s && /^SF\d+$/.test(h)) {
        s = h; h = "";
        corrections["senate-file-number"] = s;
        corrections["house-file-number"] = "";
      }
      return { houseNumber: h || "", senateNumber: s || "", corrections };
    }

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
        const pdf = texts.find(t => /pdf/i.test(t?.mime || "") || /\.pdf($|\?)/i.test(t?.url || ""));
        if (pdf) return pdf.url || pdf.state_link || null;
        const first = texts[0];
        if (first) return first.url || first.state_link || null;
      }
      return info.state_link || info.url || null;
    }

    async function patchItem(itemId, data, { live } = {}) {
      const u = new URL(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`);
      if (live) u.searchParams.set("live", "true");
      return fetch(u.toString(), {
        method: "PATCH",
        headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }

    // List items
    const listRes = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
      headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` },
    });
    if (!listRes.ok) throw new Error(`Webflow API error: ${listRes.status}`);
    const bills = (await listRes.json()).items || [];

    for (const bill of bills) {
      results.processed++;

      const rawHouse = bill.fieldData["house-file-number"] || "";
      const rawSenate = bill.fieldData["senate-file-number"] || "";
      const currentName = bill.fieldData["name"]?.trim() || "";
      const jurisdiction = bill.fieldData["jurisdiction"]?.trim() || "";
      const legislativeYear = bill.fieldData["legislative-year"]?.toString().trim();

      const { houseNumber, senateNumber, corrections } = normalizeNumbers(rawHouse, rawSenate);

      if (!houseNumber && !senateNumber) {
        results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No HF/SF number" }); continue;
      }

      const state = /^federal$/i.test(jurisdiction) ? "US" : "MN";

      try {
        // Fetch info only for numbers that actually exist
        let houseInfo = null, senateInfo = null, primaryInfo = null, primaryNumber = houseNumber || senateNumber;
        primaryInfo = await fetchLegiScanBill({ state, billNumber: primaryNumber, year: legislativeYear });
        if (houseNumber && primaryNumber !== houseNumber) {
          await sleep(180);
          houseInfo = await fetchLegiScanBill({ state, billNumber: houseNumber, year: legislativeYear });
        } else if (houseNumber) {
          houseInfo = primaryInfo;
        }
        if (senateNumber && primaryNumber !== senateNumber) {
          await sleep(180);
          senateInfo = await fetchLegiScanBill({ state, billNumber: senateNumber, year: legislativeYear });
        } else if (senateNumber) {
          senateInfo = primaryInfo;
        }

        const updateData = { fieldData: {} };

        // Fix misfiled numbers in CMS if needed
        Object.assign(updateData.fieldData, corrections);

        // Headline (but not description)
        if (isPlaceholderName(currentName, primaryNumber)) {
          updateData.fieldData["name"] = primaryInfo.title || primaryNumber;
        }

        // Status
        if (primaryInfo.status && STATUS_MAP[primaryInfo.status]) {
          updateData.fieldData["bill-status"] = STATUS_MAP[primaryInfo.status];
        }

        // Links: only set if the corresponding number exists
        if (houseNumber) {
          const link = pickBestTextUrl(houseInfo);
          if (link) updateData.fieldData["house-file-link"] = link;
        } else {
          // ensure no stale link in house field if we just moved it away
          if (corrections["house-file-number"] === "") updateData.fieldData["house-file-link"] = "";
        }

        if (senateNumber) {
          const link = pickBestTextUrl(senateInfo);
          if (link) updateData.fieldData["senate-file-link"] = link;
        } else {
          if (corrections["senate-file-number"] === "") updateData.fieldData["senate-file-link"] = "";
        }

        if (!Object.keys(updateData.fieldData).length) {
          results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No changes to apply" }); continue;
        }

        // Patch staging then live
        const staging = await patchItem(bill.id, updateData, { live: false });
        if (!staging.ok) {
          const e = await staging.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Staging update failed: ${e.message || staging.statusText}` });
          continue;
        }
        await sleep(180);
        const live = await patchItem(bill.id, updateData, { live: true });
        if (!live.ok) {
          const e = await live.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Live update failed: ${e.message || live.statusText}` });
          continue;
        }

        results.updated++;
        results.bills.push({ id: bill.id, houseNumber, senateNumber, headline: updateData.fieldData.name || currentName, status: "updated" });
        await sleep(250);
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
