// /api/test-legiscan.js
// Test endpoint for LegiScan API - accessible at https://your-app.vercel.app/api/test-legiscan

export default async function handler(req, res) {
  // Set CORS headers for browser testing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Get API key from environment variable
    const API_KEY = process.env.LEGISCAN_API_KEY || 'bcbd43b211523761a89cfc1622415e7e';
    
    const results = {
      timestamp: new Date().toISOString(),
      tests: []
    };

    // Test 1: Get Minnesota bills
    console.log('Testing getMasterList for Minnesota...');
    const mnResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getMasterList&state=MN`);
    const mnData = await mnResponse.json();
    
    if (mnData.status === 'OK') {
      const billCount = Object.keys(mnData.masterlist).length;
      results.tests.push({
        test: 'getMasterList (MN)',
        status: 'success',
        message: `Found ${billCount} bills in Minnesota`,
        sampleBills: Object.keys(mnData.masterlist).slice(0, 3).map(id => ({
          id: mnData.masterlist[id].bill_id,
          number: mnData.masterlist[id].number,
          status: mnData.masterlist[id].status,
          lastAction: mnData.masterlist[id].last_action
        }))
      });

      // Test 2: Get detailed bill info for first bill
      if (billCount > 0) {
        const firstBillId = mnData.masterlist[Object.keys(mnData.masterlist)[0]].bill_id;
        console.log(`Testing getBill for ID: ${firstBillId}...`);
        
        const billResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getBill&id=${firstBillId}`);
        const billData = await billResponse.json();
        
        if (billData.status === 'OK') {
          results.tests.push({
            test: 'getBill (detailed)',
            status: 'success',
            message: 'Successfully retrieved bill details',
            billDetails: {
              number: billData.bill.bill_number,
              title: billData.bill.title?.substring(0, 100) + '...',
              status: billData.bill.status_text,
              sponsors: billData.bill.sponsors?.length || 0,
              history: billData.bill.history?.length || 0
            }
          });
        } else {
          results.tests.push({
            test: 'getBill (detailed)',
            status: 'error',
            message: billData.alert?.message || 'Failed to get bill details'
          });
        }
      }
    } else {
      results.tests.push({
        test: 'getMasterList (MN)',
        status: 'error',
        message: mnData.alert?.message || 'Failed to get Minnesota bills'
      });
    }

    // Test 3: Search functionality
    console.log('Testing search for "education"...');
    const searchResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getSearch&state=MN&query=education`);
    const searchData = await searchResponse.json();
    
    if (searchData.status === 'OK') {
      results.tests.push({
        test: 'getSearch (education)',
        status: 'success',
        message: `Found ${searchData.searchresult?.length || 0} bills matching "education"`,
        sampleResults: searchData.searchresult?.slice(0, 3).map(result => ({
          billNumber: result.bill_number,
          title: result.title?.substring(0, 80) + '...'
        })) || []
      });
    } else {
      results.tests.push({
        test: 'getSearch (education)',
        status: 'error',
        message: searchData.alert?.message || 'Search failed'
      });
    }

    // Return results
    res.status(200).json({
      success: true,
      ...results,
      apiInfo: {
        endpoint: 'https://api.legiscan.com',
        keyPresent: !!API_KEY,
        documentation: 'https://legiscan.com/gaits/documentation/legiscan'
      }
    });

  } catch (error) {
    console.error('Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'API test failed. Check server logs for details.'
    });
  }
}
