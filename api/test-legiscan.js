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
    // Get API key from environment variable or fallback to hardcoded
    const API_KEY = process.env.LEGISCAN_API_KEY || 'bcbd43b211523761a89cfc1622415e7e';
    
    const results = {
      timestamp: new Date().toISOString(),
      tests: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0
      }
    };

    // Helper function to add test result
    function addTest(name, success, message, data = null) {
      results.tests.push({
        test: name,
        status: success ? 'success' : 'error',
        message: message,
        data: data
      });
      results.summary.total++;
      if (success) results.summary.passed++;
      else results.summary.failed++;
    }

    // Test 1: Get Minnesota bills
    try {
      console.log('Testing getMasterList for Minnesota...');
      const mnResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getMasterList&state=MN`);
      const mnData = await mnResponse.json();
      
      if (mnData.status === 'OK' && mnData.masterlist) {
        const billCount = Object.keys(mnData.masterlist).length;
        const sampleBills = Object.keys(mnData.masterlist).slice(0, 3).map(id => {
          const bill = mnData.masterlist[id];
          return {
            id: bill.bill_id,
            number: bill.number,
            status: bill.status,
            lastAction: bill.last_action,
            statusDate: bill.status_date
          };
        });
        
        addTest('getMasterList (MN)', true, `Found ${billCount} bills in Minnesota`, sampleBills);
      } else {
        addTest('getMasterList (MN)', false, mnData.alert?.message || 'Failed to get Minnesota bills');
      }
    } catch (error) {
      addTest('getMasterList (MN)', false, `Request failed: ${error.message}`);
    }

    // Test 2: Get detailed bill info (only if we have bills from test 1)
    if (results.summary.passed > 0) {
      try {
        // Get the first bill ID from our previous test
        const mnResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getMasterList&state=MN`);
        const mnData = await mnResponse.json();
        
        if (mnData.status === 'OK' && mnData.masterlist) {
          const firstBillId = mnData.masterlist[Object.keys(mnData.masterlist)[0]].bill_id;
          console.log(`Testing getBill for ID: ${firstBillId}...`);
          
          const billResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getBill&id=${firstBillId}`);
          const billData = await billResponse.json();
          
          if (billData.status === 'OK' && billData.bill) {
            const bill = billData.bill;
            const billDetails = {
              number: bill.bill_number,
              title: bill.title ? bill.title.substring(0, 100) + '...' : 'No title',
              status: bill.status_text,
              sponsors: bill.sponsors ? bill.sponsors.length : 0,
              history: bill.history ? bill.history.length : 0,
              description: bill.description ? bill.description.substring(0, 150) + '...' : 'No description'
            };
            
            addTest('getBill (detailed)', true, 'Successfully retrieved bill details', billDetails);
          } else {
            addTest('getBill (detailed)', false, billData.alert?.message || 'Failed to get bill details');
          }
        }
      } catch (error) {
        addTest('getBill (detailed)', false, `Request failed: ${error.message}`);
      }
    }

    // Test 3: Search functionality
    try {
      console.log('Testing search for "education"...');
      const searchResponse = await fetch(`https://api.legiscan.com/?key=${API_KEY}&op=getSearch&state=MN&query=education`);
      const searchData = await searchResponse.json();
      
      if (searchData.status === 'OK') {
        // Handle different possible response formats
        let searchResults = [];
        if (searchData.searchresult) {
          if (Array.isArray(searchData.searchresult)) {
            searchResults = searchData.searchresult;
          } else if (typeof searchData.searchresult === 'object') {
            // Sometimes it's an object with numeric keys
            searchResults = Object.values(searchData.searchresult);
          }
        }
        
        const sampleResults = searchResults.slice(0, 3).map(result => ({
          billNumber: result.bill_number || 'Unknown',
          title: result.title ? result.title.substring(0, 80) + '...' : 'No title',
          relevance: result.relevance || 'N/A'
        }));
        
        addTest('getSearch (education)', true, `Found ${searchResults.length} bills matching "education"`, sampleResults);
      } else {
        addTest('getSearch (education)', false, searchData.alert?.message || 'Search failed');
      }
    } catch (error) {
      addTest('getSearch (education)', false, `Request failed: ${error.message}`);
    }

    // Test 4: API Key validation
    const keyTest = API_KEY && API_KEY !== 'YOUR_API_KEY_HERE';
    addTest('API Key', keyTest, keyTest ? 'API key is present' : 'API key is missing or default');

    // Return comprehensive results
    res.status(200).json({
      success: results.summary.failed === 0,
      timestamp: results.timestamp,
      summary: results.summary,
      tests: results.tests,
      apiInfo: {
        endpoint: 'https://api.legiscan.com',
        keyPresent: !!API_KEY,
        keySource: process.env.LEGISCAN_API_KEY ? 'environment' : 'hardcoded',
        documentation: 'https://legiscan.com/gaits/documentation/legiscan'
      },
      nextSteps: results.summary.failed === 0 ? [
        'API is working correctly',
        'Ready to integrate with Webflow CMS',
        'Can start building bill tracking features'
      ] : [
        'Check API key configuration',
        'Verify LegiScan service status',
        'Review error messages above'
      ]
    });

  } catch (error) {
    console.error('Test failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'API test failed. Check server logs for details.',
      timestamp: new Date().toISOString()
    });
  }
}
