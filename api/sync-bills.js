// /api/sync-bills.js
export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = process.env.WEBFLOW_BILLS_COLLECTION_ID;

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY || !COLLECTION_ID) {
      return res.status(400).json({ success: false, error: "Missing environment variables" });
    }

    const results = { timestamp: new Date().toISOString(), processed: 0, updated: 0, skipped: 0, skipReasons: [], errors: [], bills: [] };
    const toPublish = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Webflow Option IDs (your IDs)
    const statusMapping = {
      Active: "960eac22ecc554a51654e69b9252ae80",
      Tabled: "7febd1eb78c2ea008f4f84c13afec8de",
      Failed: "e15117e822e62b30d4c8a74770630f01",
      Passed: "d6de8b3f124dbc8e474cf520bfe7e9ca",
    };

    const computeStatus = (billInfo, { state, legislativeYear }) => {
      const code = billInfo.status;
      if (code === 4) return statusMapping.Passed;
      if (code === 5 || code === 6) return statusMapping.Failed;

      const year = Number(legislativeYear);
      const cutoff = state === "MN" && year ? new Date(year, 5, 1) : null; // Jun 1
      const la = (billInfo.last_action || "").toLowerCase();
      const looksDead = /tabled|laid on table|postponed|indefinitely|sine die|died|withdrawn|stricken/.test(la);

      if (looksDead) return statusMapping.Tabled;
      if (cutoff && new Date() >= cutoff && (code === 1 || code === 2 || code === 3)) return statusMapping.Tabled;

      return statusMapping.Active;
    };

    const isPlaceholderName = (name, billNum) => {
      const n = (name || "").trim();
      return !n || (billNum && n.toUpperCase() === billNum.toUpperCase()) || /^[HS]F[-\s]?\d+$/i.test(n) || /^(untitled|tbd|placeholder)$/i.test(n);
    };

    function normalizeNumbers(rawHouse, rawSenate) {
      const norm = v => (v || "").toUpperCase().replace(/[\s-]+/g, "");
      let h = norm(rawHouse), s = norm(rawSenate);
      const corrections = {};
      if (!h && /^HF\d+$/.test(s)) { h = s; s = ""; corrections["house-file-number"] = h; corrections["senate-file-number"] = ""; }
      if (!s && /^SF\d+$/.test(h)) { s = h; h = ""; corrections["senate-file-number"] = s; corrections["house-file-number"] = ""; }
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

    async function patchStaging(itemId, data) {
      const u = `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`;
      return fetch(u, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }

    async function publishItems(itemIds) {
      const u = `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/publish`;
      return fetch(u, {
        method: "POST",
        headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds }), // v2 publish endpoint
      });
    }

    // Fetch items
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
        const primaryNumber = houseNumber || senateNumber;
        const primaryInfo = await fetchLegiScanBill({ state, billNumber: primaryNumber, year: legislativeYear });

        let houseInfo = null, senateInfo = null;
        if (houseNumber) houseInfo = primaryNumber === houseNumber ? primaryInfo : await (sleep(180), fetchLegiScanBill({ state, billNumber: houseNumber, year: legislativeYear }));
        if (senateNumber) senateInfo = primaryNumber === senateNumber ? primaryInfo : await (sleep(180), fetchLegiScanBill({ state, billNumber: senateNumber, year: legislativeYear }));

        // Build timeline HTML (optional field)
        let timelineHtml = "";
        if (primaryInfo.history && Array.isArray(primaryInfo.history) && primaryInfo.history.length > 0) {
          const sortedHistory = [...primaryInfo.history].sort((a, b) => new Date(b.date) - new Date(a.date));
          timelineHtml = `<div class="timeline"><h4>LAST ACTION</h4>`;
          sortedHistory.forEach((item, index) => {
            const isRecent = index < 3;
            const chamber = item.chamber === "H" ? "House" : item.chamber === "S" ? "Senate" : item.chamber;
            const importance = item.importance === 1 ? " (Major)" : "";
            timelineHtml += `
              <div class="timeline-item${isRecent ? " recent" : ""}">
                <p><strong>${item.date}</strong></p>
                <p>${item.action}${importance}</p>
                ${chamber ? `<p><small>${chamber}</small></p>` : ""}
              </div>`;
          });
          timelineHtml += `</div>`;
        }

        const updateData = { fieldData: {} };

        // Fix misfiled numbers
        Object.assign(updateData.fieldData, corrections);

        // Headline (only if placeholder)
        if (isPlaceholderName(currentName, primaryNumber)) {
          updateData.fieldData["name"] = primaryInfo.title || primaryNumber;
        }

        // Status (Option ID)
        const wfStatusId = computeStatus(primaryInfo, { state, legislativeYear });
        if (wfStatusId) updateData.fieldData["bill-status"] = wfStatusId;

        // Timeline (ensure your collection has a 'timeline' field)
        if (timelineHtml) updateData.fieldData["timeline"] = timelineHtml;

        // Links
        if (houseNumber) {
          const link = pickBestTextUrl(houseInfo);
          if (link) updateData.fieldData["house-file-link"] = link;
        } else if (corrections["house-file-number"] === "") {
          updateData.fieldData["house-file-link"] = "";
        }
        if (senateNumber) {
          const link = pickBestTextUrl(senateInfo);
          if (link) updateData.fieldData["senate-file-link"] = link;
        } else if (corrections["senate-file-number"] === "") {
          updateData.fieldData["senate-file-link"] = "";
        }

        if (!Object.keys(updateData.fieldData).length) {
          results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No changes to apply" }); continue;
        }

        // Patch STAGING only
        const staging = await patchStaging(bill.id, updateData);
        if (!staging.ok) {
          const e = await staging.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Staging update failed: ${e.message || staging.statusText}` });
          continue;
        }

        // Queue for publish
        toPublish.push(bill.id);

        const statusText = Object.keys(statusMapping).find(k => statusMapping[k] === wfStatusId);
        results.updated++;
        results.bills.push({
          id: bill.id,
          houseNumber,
          senateNumber,
          headline: updateData.fieldData.name || currentName,
          status: "staged",
          setStatus: statusText,
          timelinePreview: timelineHtml ? "Timeline generated" : "No timeline data",
        });

        await sleep(120);
      } catch (err) {
        results.errors.push({ billId: bill.id, error: err.message });
      }
    }

    // Publish all staged updates to LIVE in one call (or chunks of 100)
    const chunk = 100;
    for (let i = 0; i < toPublish.length; i += chunk) {
      const slice = toPublish.slice(i, i + chunk);
      const pubRes = await publishItems(slice);
      if (!pubRes.ok) {
        const e = await pubRes.json().catch(() => ({}));
        results.errors.push({ error: `Publish failed: ${e.message || pubRes.statusText}`, affectedItems: slice });
      } else {
        const body = await pubRes.json().catch(() => ({}));
        // Optional: attach publish result
        results.bills.push({ published: body.publishedItemIds?.length || 0, errors: body.errors || [] });
      }
      // Publish endpoints are throttled; be nice.
      await sleep(900);
    }

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      summary: {
        totalBills: bills.length,
        processed: results.processed,
        updated: results.updated,
        skipped: results.skipped,
        publishedBatches: Math.ceil(toPublish.length / 100) || 0,
        errors: results.errors.length
      },
      updatedBills: results.bills,
      skipReasons: results.skipReasons.length ? results.skipReasons : undefined,
      errors: results.errors.length ? results.errors : undefined,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message, message: "Bills sync failed" });
  }
}
