// /api/get-bill.js
// Get specific bill data by bill number (e.g., HF12, SF916)
// Usage: /api/get-bill?number=HF12 or /api/get-bill?numbers=HF12,SF916

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const API_KEY = process.env.LEGISCAN_API_KEY || 'bcbd43b211523761a89cfc1622415e7e';
    
    // Get bill numbers from query parameters
    const { number, numbers } = req.query;
    
    let billNumbers = [];
    if (number) {
      billNumbers = [number];
    } else if (numbers) {
      billNumbers = numbers.split(',').map(n => n.trim());
    } else {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter',
        message: 'Please provide either "number" (single bill) or "numbers" (comma-separated list)',
        examples: [
          '/api/get-bill?number=HF12',
          '/api/get-bill?numbers=HF12,SF916'
        ]
      });
    }

    const results = {
      timestamp: new Date().toISOString(),
      requestedBills: billNumbers,
      bills: [],
      errors: []
    };

    // Helper function to get bill details by number
    async function getBillByNumber(billNumber) {
      try {
        // First, search for the bill to get its ID
        console.log(`Searching for bill: ${billNumber}`);
        const searchResponse = await fetch(
          `https://api.legiscan.com/?key=${API_KEY}&op=getBill&state=MN&bill=${billNumber}`
        );
        const billData = await searchResponse.json();

        if (billData.status === 'OK' && billData.bill) {
          const bill = billData.bill;
          
          return {
            success: true,
            billNumber: billNumber,
            data: {
              // Basic info
              bill_id: bill.bill_id,
              bill_number: bill.bill_number,
              title: bill.title,
              description: bill.description,
              
              // Status info
              status: bill.status,
              status_text: bill.status_text,
              status_date: bill.status_date,
              
              // Legislative info
              session: {
                session_id: bill.session.session_id,
                year_start: bill.session.year_start,
                year_end: bill.session.year_end,
                name: bill.session.session_name
              },
              
              // Sponsors
              sponsors: bill.sponsors ? bill.sponsors.map(sponsor => ({
                people_id: sponsor.people_id,
                name: sponsor.name,
                first_name: sponsor.first_name,
                last_name: sponsor.last_name,
                party: sponsor.party,
                role: sponsor.sponsor_type_text
              })) : [],
              
              // History
              history: bill.history ? bill.history.slice(0, 10).map(event => ({
                date: event.date,
                action: event.action,
                chamber: event.chamber_text
              })) : [],
              
              // Subjects/topics
              subjects: bill.subjects || [],
              
              // Text versions
              texts: bill.texts ? bill.texts.map(text => ({
                doc_id: text.doc_id,
                type: text.type_text,
                date: text.date,
                mime: text.mime
              })) : [],
              
              // Votes
              votes: bill.votes ? bill.votes.map(vote => ({
                roll_call_id: vote.roll_call_id,
                date: vote.date,
                desc: vote.desc,
                yea: vote.yea,
                nay: vote.nay,
                nv: vote.nv,
                absent: vote.absent
              })) : [],
              
              // URLs
              state_link: bill.state_link,
              completed: bill.completed
            }
          };
        } else {
          return {
            success: false,
            billNumber: billNumber,
            error: billData.alert?.message || `Bill ${billNumber} not found`
          };
        }
      } catch (error) {
        return {
          success: false,
          billNumber: billNumber,
          error: `Request failed: ${error.message}`
        };
      }
    }

    // Process each requested bill
    for (const billNumber of billNumbers) {
      const result = await getBillByNumber(billNumber);
      
      if (result.success) {
        results.bills.push(result.data);
      } else {
        results.errors.push({
          billNumber: result.billNumber,
          error: result.error
        });
      }
    }

    // Return results
    res.status(200).json({
      success: results.bills.length > 0,
      timestamp: results.timestamp,
      summary: {
        requested: billNumbers.length,
        found: results.bills.length,
        errors: results.errors.length
      },
      bills: results.bills,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (error) {
    console.error('Bill lookup failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Bill lookup failed. Check server logs for details.',
      timestamp: new Date().toISOString()
    });
  }
}
