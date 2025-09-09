// /api/sync-bills.js
export default async function handler(req, res) {
  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY;
    const COLLECTION_ID = process.env.WEBFLOW_BILLS_COLLECTION_ID; // required

    if (!WEBFLOW_TOKEN || !LEGISCAN_API_KEY || !COLLECTION_ID) {
      return res.status(400).json({ success: false, error: "Missing environment variables" });
    }

    const results = { timestamp: new Date().toISOString(), processed: 0, updated: 0, skipped: 0, skipReasons: [], errors: [], bills: [] };
    const toPublish = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // --- Webflow Option IDs (Bill Status)
    const statusMapping = {
      Active: "960eac22ecc554a51654e69b9252ae80",
      Tabled: "7febd1eb78c2ea008f4f84c13afec8de",
      Failed: "e15117e822e62b30d4c8a74770630f01",
      Passed: "d6de8b3f124dbc8e474cf520bfe7e9ca",
    };

    // --- Helpers ------------------------------------------------------------
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
        texts.sort((a, b) => new Date(b.date || b.action_date || 0) - new Date(a.date || a.action_date || 0));
        const pdf = texts.find(t => /pdf/i.test(t?.mime || "") || /\.pdf($|\?)/i.test(t?.url || ""));
        if (pdf) return pdf.url || pdf.state_link || null;
        const first = texts[0];
        if (first) return first.url || first.state_link || null;
      }
      return info.state_link || info.url || null;
    }

    const esc = (s='') => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = (d) => {
      if (!d) return '';
      const [y,m,day] = (d.split('T')[0] || '').split('-');
      const dt = (y && m && day) ? new Date(+y, +m-1, +day) : new Date(d);
      return isNaN(dt) ? esc(d) : dt.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    };

    function buildTimelineHtml(info) {
      const hist = Array.isArray(info?.history) ? [...info.history] : [];
      if (!hist.length) {
        const d = info?.last_action_date || info?.status_date || '';
        const a = info?.last_action || 'No recent actions recorded';
        if (!d && !a) return '';
        const dateText = fmt(d);
        return dateText ? `<p><strong>${esc(dateText)}</strong><br>${esc(a)}</p>` : `<p>${esc(a)}</p>`;
      }

      hist.sort((a,b) => new Date(b.date || b.action_date || 0) - new Date(a.date || a.action_date || 0));
      
      // Group actions by date
      const groupedByDate = new Map();
      hist.forEach(item => {
        const dateKey = item.date || item.action_date || '';
        const action = item.action || '';
        if (!groupedByDate.has(dateKey)) {
          groupedByDate.set(dateKey, []);
        }
        groupedByDate.get(dateKey).push(action);
      });

      // Convert to HTML with grouped dates
      const rows = Array.from(groupedByDate.entries()).map((entry, index) => {
        const [dateKey, actions] = entry;
        const dateText = fmt(dateKey);
        
        if (actions.length === 1) {
          // Single action: keep original format
          const html = dateText ? `<p><strong>${esc(dateText)}</strong><br>${esc(actions[0])}</p>` : `<p>${esc(actions[0])}</p>`;
          return index < groupedByDate.size - 1 ? html + '<br>' : html;
        } else {
          // Multiple actions: use bullet list
          const actionItems = actions.map(action => `• ${esc(action)}`).join('<br>');
          const html = dateText ? `<p><strong>${esc(dateText)}</strong><br>${actionItems}</p>` : `<p>${actionItems}</p>`;
          return index < groupedByDate.size - 1 ? html + '<br>' : html;
        }
      }).join('');

      return rows;
    }

    // --- Sponsors helper with Rep./Sen. prefix ------------------------------
    function buildSponsorsHtml(info, { state = "MN" } = {}) {
      const list = Array.isArray(info?.sponsors) ? [...info.sponsors] : [];
      if (!list.length) return "";

      const sponsorTypeRank = (typeId) => {
        // Only include Primary Sponsors (rank 0), exclude all others
        if (typeId === 1) return 0; // Primary Sponsor only
        return 999; // Exclude Co-Sponsors (2), Joint Sponsors (3), and Generic (0)
      };

      const prefixFor = (s) => {
        // Try role_id first (more reliable): 1=Rep, 2=Sen
        const roleId = Number(s?.role_id ?? 0);
        if (roleId === 1) return "Rep.";
        if (roleId === 2) return "Sen.";

        // Fallback to text-based detection
        const roleText = String(s?.role ?? "").toLowerCase();
        if (roleText === "sen" || roleText === "senator") return "Sen.";
        if (roleText === "rep" || roleText === "representative") return "Rep.";

        // Legacy chamber detection
        const ch = String(s?.chamber ?? s?.chamber_id ?? s?.type ?? "").toLowerCase();
        if (ch === "s" || ch === "senate" || ch === "upper") return "Sen.";
        if (ch === "h" || ch === "house"  || ch === "lower") return "Rep.";

        // Minnesota-specific district pattern matching
        const dist = String(s?.district ?? "");
        if (state === "MN") {
          if (/^\d{1,3}[A-B]$/i.test(dist)) return "Rep.";
          if (/^\d{1,3}$/.test(dist))       return "Sen.";
        }
        
        return "";
      };

      // Filter to only include Primary Sponsors (rank 0)
      const filteredList = list.filter(s => sponsorTypeRank(s?.sponsor_type_id) === 0);

      filteredList.sort((a, b) => (a?.name || "").localeCompare(b?.name || ""));

      const seen = new Set();
      const items = filteredList.filter((s) => {
        const key = [s?.name, s?.sponsor_type_id, s?.party, s?.district].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return items.map((s, i) => {
        const pref  = prefixFor(s);
        const name  = s?.name ? esc(s.name) : "";
        const party = s?.party ? ` (${esc(String(s.party))})` : "";
        const line  = `${pref} ${name}${party}`.trim();
        return i < items.length - 1 ? `<p>${line}</p><br>` : `<p>${line}</p>`;
      }).join("");
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
        body: JSON.stringify({ itemIds }), // ← Fixed: camelCase instead of item_ids
      });
    }

    // --- Fetch items --------------------------------------------------------
    const listRes = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
      headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` },
    });
    if (!listRes.ok) throw new Error(`Webflow API error: ${listRes.status}`);
    const bills = (await listRes.json()).items || [];

    // --- Process items ------------------------------------------------------
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
        if (houseNumber && primaryNumber !== houseNumber) {
          await sleep(150);
          houseInfo = await fetchLegiScanBill({ state, billNumber: houseNumber, year: legislativeYear });
        } else {
          houseInfo = primaryInfo;
        }
        if (senateNumber && primaryNumber !== senateNumber) {
          await sleep(150);
          senateInfo = await fetchLegiScanBill({ state, billNumber: senateNumber, year: legislativeYear });
        } else {
          senateInfo = primaryInfo;
        }

        const updateData = { fieldData: {} };
        Object.assign(updateData.fieldData, corrections);

        if (isPlaceholderName(currentName, primaryNumber)) {
          updateData.fieldData["name"] = primaryInfo.title || primaryNumber;
        }

        const wfStatusId = computeStatus(primaryInfo, { state, legislativeYear });
        if (wfStatusId) updateData.fieldData["bill-status"] = wfStatusId;

        const timelineHtml = buildTimelineHtml(primaryInfo);
        updateData.fieldData["timeline"] = timelineHtml || "";

        const sponsorsHtml = buildSponsorsHtml(primaryInfo, { state });
        updateData.fieldData["sponsors"] = sponsorsHtml || "";

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

        const staging = await patchStaging(bill.id, updateData);
        if (!staging.ok) {
          const e = await staging.json().catch(() => ({}));
          results.errors.push({ billId: bill.id, error: `Staging update failed: ${e.message || staging.statusText}` });
          continue;
        }

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

    // --- Publish to LIVE in batches ----------------------------------------
    let publishedOk = 0; // Track actual successful publishes
    const CHUNK = 100;
    for (let i = 0; i < toPublish.length; i += CHUNK) {
      const slice = toPublish.slice(i, i + CHUNK);
      const pub = await publishItems(slice);
      const body = await pub.json().catch(() => ({}));

      if (!pub.ok) {
        results.errors.push({
          error: `Publish failed: ${body.message || body.error || pub.statusText}`,
          details: body,
          affectedItems: slice,
        });
      } else {
        // Handle different possible response formats from Webflow
        const ids = Array.isArray(body.itemIds) ? body.itemIds
                 : Array.isArray(body.items) ? body.items.map(x => x.id)
                 : [];
        publishedOk += ids.length;
        results.bills.push({ 
          publishedCount: ids.length, 
          itemIds: ids.length ? ids : slice 
        });
      }
      await sleep(700);
    }

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      summary: {
        totalBills: bills.length,
        processed: results.processed,
        updated: results.updated,
        skipped: results.skipped,
        published: publishedOk, // ← Now reports actual successful publishes
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
