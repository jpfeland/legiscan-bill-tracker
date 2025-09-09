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

    // --- Fetch collection schema and build option maps dynamically
    async function getOptionIdMaps() {
      const u = `https://api.webflow.com/v2/collections/${COLLECTION_ID}`;
      const r = await fetch(u, { headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` } });
      if (!r.ok) throw new Error(`Failed to load collection schema: ${r.status}`);
      const col = await r.json();

      const bySlug = Object.fromEntries(
        (col.fields || []).map(f => [f.slug, f])
      );

      function makeMap(slug, names) {
        const f = bySlug[slug];
        if (!f) throw new Error(`Field not found: ${slug}`);
        if (f.type !== "Option") throw new Error(`Field ${slug} is not Option type`);
        const opts = (f.validations?.options) || [];
        const map = {};
        names.forEach(name => {
          const opt = opts.find(o => o.name.toLowerCase() === name.toLowerCase());
          if (!opt) throw new Error(`Option "${name}" not found on ${slug}`);
          map[name] = opt.id;
        });
        return map;
      }

      // Build maps for each field independently
      return {
        houseStatusIds: makeMap("house-file-status", ["Active","Tabled","Failed","Passed"]),
        senateStatusIds: makeMap("senate-file-status", ["Active","Tabled","Failed","Passed"]),
        jurisdictionIds: makeMap("jurisdiction", ["Minnesota","Federal"]),
      };
    }

    // --- Webflow Option IDs (Jurisdiction) - Keep this static since it's simple
    const JURISDICTION_MAP = {
      "3b566a1d5376e736be044c288bb44017": "MN", // Minnesota
      "87a300e03b5ad785b240294477aaaf35": "US", // Federal
    };

    // --- Helpers ------------------------------------------------------------
    function computeStatusKey(billInfo, { state, legislativeYear }) {
      const code = billInfo.status;
      if (code === 4) return "Passed";
      if (code === 5 || code === 6) return "Failed";

      const year = Number(legislativeYear);
      const cutoff = state === "MN" && year ? new Date(year, 5, 1) : null; // Jun 1
      const la = (billInfo.last_action || "").toLowerCase();
      const looksDead = /tabled|laid on the? table|postponed|indefinitely|sine die|died|withdrawn|stricken/.test(la);

      if (looksDead) return "Tabled";
      if (cutoff && new Date() >= cutoff && (code === 1 || code === 2 || code === 3)) return "Tabled";

      return "Active";
    }

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
      let searchNumber = billNumber;
      
      if (state === "US") {
        // For federal bills, try multiple formats
        if (/^HR\d+$/i.test(billNumber)) {
          // First try as House Bill (HB) - most common
          try {
            searchNumber = billNumber.replace(/^HR/i, "HB");
            let url = `https://api.legiscan.com/?key=${encodeURIComponent(LEGISCAN_API_KEY)}&op=getBill&state=${encodeURIComponent(state)}&bill=${encodeURIComponent(searchNumber)}`;
            if (year) url += `&year=${encodeURIComponent(year)}`;
            const r = await fetch(url);
            const data = await r.json();
            if (data.status === "OK" && data.bill) return data.bill;
          } catch (e) {
            // Fall through to try HR format
          }
          
          // If HB failed, try as House Resolution (HR)
          searchNumber = billNumber; // Keep original HR format
        }
        // Convert Senate numbers: S -> SB, SR stays SR
        else if (/^S\d+$/i.test(billNumber)) {
          searchNumber = billNumber.replace(/^S/i, "SB");
        }
      }

      let url = `https://api.legiscan.com/?key=${encodeURIComponent(LEGISCAN_API_KEY)}&op=getBill&state=${encodeURIComponent(state)}&bill=${encodeURIComponent(searchNumber)}`;
      if (year) url += `&year=${encodeURIComponent(year)}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.status !== "OK" || !data.bill) throw new Error(data.alert?.message || `Bill not found: ${searchNumber}`);
      return data.bill;
    }

    function pickBestTextUrl(info) {
      if (!info) return null;
      const texts = Array.isArray(info.texts) ? info.texts.slice() : [];
      if (texts.length) {
        texts.sort((a, b) => new Date(b.date || b.action_date || 0) - new Date(a.date || a.action_date || 0));
        
        // Prioritize state_link (often direct PDF) over LegiScan URL
        const pdf = texts.find(t => /pdf/i.test(t?.mime || "") || /\.pdf($|\?)/i.test(t?.state_link || t?.url || ""));
        if (pdf) {
          // Debug: Log the URLs being returned to see what's happening
          console.log("PDF text found:", { state_link: pdf.state_link, url: pdf.url, mime: pdf.mime });
          return pdf.state_link || pdf.url || null;
        }
        
        const first = texts[0];
        if (first) {
          console.log("First text found:", { state_link: first.state_link, url: first.url, mime: first.mime });
          return first.state_link || first.url || null;
        }
      }
      
      // Fallback to main bill links
      console.log("Fallback to main bill links:", { state_link: info.state_link, url: info.url });
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
        // Include Primary Sponsors (rank 0) and Joint Sponsors (rank 1)
        if (typeId === 1) return 0; // Primary Sponsor (highest priority)
        if (typeId === 3) return 1; // Joint Sponsor
        return 999; // Exclude Co-Sponsors (2) and Generic (0)
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

      // Filter to include Primary Sponsors (rank 0) and Joint Sponsors (rank 1)
      const filteredList = list.filter(s => sponsorTypeRank(s?.sponsor_type_id) < 999);

      filteredList.sort(
        (a, b) => sponsorTypeRank(a?.sponsor_type_id) - sponsorTypeRank(b?.sponsor_type_id) ||
                  (a?.name || "").localeCompare(b?.name || "")
      );

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

    // Helper to create URL-friendly slug
    const createSlug = (text) => {
      return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
        .replace(/\s+/g, '-')         // Replace spaces with hyphens
        .replace(/-+/g, '-')          // Replace multiple hyphens with single
        .replace(/^-|-$/g, '')        // Remove leading/trailing hyphens
        .substring(0, 80);            // Limit length for headline part
    };

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
        body: JSON.stringify({ itemIds }),
      });
    }

    // --- Fetch items --------------------------------------------------------
    const listRes = await fetch(`https://api.webflow.com/v2/collections/${COLLECTION_ID}/items`, {
      headers: { Authorization: `Bearer ${WEBFLOW_TOKEN}` },
    });
    if (!listRes.ok) throw new Error(`Webflow API error: ${listRes.status}`);
    const bills = (await listRes.json()).items || [];

    // Get dynamic option ID mappings from schema
    const { houseStatusIds, senateStatusIds, jurisdictionIds } = await getOptionIdMaps();

    // --- Process items ------------------------------------------------------
    for (const bill of bills) {
      results.processed++;

      // Check for manual override - skip if enabled
      const manualOverride = bill.fieldData["manual-override"];
      if (manualOverride === true) {
        results.skipped++; 
        results.skipReasons.push({ id: bill.id, reason: "Manual override enabled" }); 
        continue;
      }

      const rawHouse = bill.fieldData["house-file-number"] || "";
      const rawSenate = bill.fieldData["senate-file-number"] || "";
      const currentName = bill.fieldData["name"]?.trim() || "";
      const jurisdictionId = bill.fieldData["jurisdiction"]; // Webflow stores the option ID
      const legislativeYear = bill.fieldData["legislative-year"]?.toString().trim();

      const { houseNumber, senateNumber, corrections } = normalizeNumbers(rawHouse, rawSenate);

      if (!houseNumber && !senateNumber) {
        results.skipped++; results.skipReasons.push({ id: bill.id, reason: "No HF/SF number" }); continue;
      }

      // Helper function to infer state from bill number patterns
      function inferStateFromNumber(h, s) {
        const n = String(h || s || "").toUpperCase();
        if (/^(HF|SF)\d+$/.test(n)) return "MN";
        if (/^(HB|SB|HR|SR|HJ|SJ|HC|SC)\d+$/.test(n)) return "US";
        return "MN";
      }

      // Use Webflow option ID to determine state, with fallback to bill number pattern
      const state = JURISDICTION_MAP[jurisdictionId] || inferStateFromNumber(houseNumber, senateNumber);

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

        // Build update payload with proper structure
        const updateData = { fieldData: {} };
        
        // Apply corrections to bill numbers
        Object.assign(updateData.fieldData, corrections);

        let billTitle = currentName;
        if (isPlaceholderName(currentName, primaryNumber)) {
          billTitle = primaryInfo.title || primaryNumber;
          updateData.fieldData["name"] = billTitle;
        }

        // Status - now separate for House and Senate using dynamic IDs
        if (houseNumber && houseInfo) {
          const statusKey = computeStatusKey(houseInfo, { state, legislativeYear });
          updateData.fieldData["house-file-status"] = houseStatusIds[statusKey];
        }
        
        if (senateNumber && senateInfo) {
          const statusKey = computeStatusKey(senateInfo, { state, legislativeYear });
          updateData.fieldData["senate-file-status"] = senateStatusIds[statusKey];
        }

        // Rich text fields
        const timelineHtml = buildTimelineHtml(primaryInfo);
        updateData.fieldData["timeline"] = timelineHtml || "";

        const sponsorsHtml = buildSponsorsHtml(primaryInfo, { state });
        updateData.fieldData["sponsors"] = sponsorsHtml || "";

        // URL fields - use null to clear, not empty string
        if (houseNumber) {
          const link = pickBestTextUrl(houseInfo);
          if (link) updateData.fieldData["house-file-link"] = link;
        } else if (corrections["house-file-number"] === "") {
          updateData.fieldData["house-file-link"] = null;
        }
        
        if (senateNumber) {
          const link = pickBestTextUrl(senateInfo);
          if (link) updateData.fieldData["senate-file-link"] = link;
        } else if (corrections["senate-file-number"] === "") {
          updateData.fieldData["senate-file-link"] = null;
        }

        // Slug must be TOP-LEVEL, not in fieldData
        if (legislativeYear && billTitle) {
          const billNumbers = [houseNumber, senateNumber].filter(Boolean).join('-').toLowerCase();
          const headlineSlug = createSlug(billTitle);
          const structuredSlug = `${legislativeYear}--${billNumbers}--${headlineSlug}`;
          updateData.slug = structuredSlug;
        }

        if (!Object.keys(updateData.fieldData).length && !updateData.slug) {
          results.skipped++; 
          results.skipReasons.push({ id: bill.id, reason: "No changes to apply" }); 
          continue;
        }

        const staging = await patchStaging(bill.id, updateData);
        if (!staging.ok) {
          const body = await staging.json().catch(() => ({}));
          results.errors.push({
            billId: bill.id,
            error: `Staging update failed`,
            status: staging.status,
            message: body.message || staging.statusText,
            details: body.details || body,
            sentData: updateData
          });
          continue;
        }

        toPublish.push(bill.id);

        // Get status text for logging using the computed keys
        const houseStatusText = houseNumber ? computeStatusKey(houseInfo, { state, legislativeYear }) : null;
        const senateStatusText = senateNumber ? computeStatusKey(senateInfo, { state, legislativeYear }) : null;
        
        results.updated++;
        results.bills.push({
          id: bill.id,
          houseNumber,
          senateNumber,
          headline: updateData.fieldData.name || currentName,
          status: "staged",
          houseStatus: houseStatusText,
          senateStatus: senateStatusText,
          houseTimelinePreview: houseTimelineHtml ? "Timeline generated" : "No house timeline",
          senateTimelinePreview: senateTimelineHtml ? "Timeline generated" : "No senate timeline",
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
        published: publishedOk,
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
