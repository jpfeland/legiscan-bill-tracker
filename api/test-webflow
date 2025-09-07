// /api/test-webflow.js
// Test Webflow API connection and get collection info

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const WEBFLOW_TOKEN = process.env.WEBFLOW_API_TOKEN;
    const SITE_ID = process.env.WEBFLOW_SITE_ID;

    if (!WEBFLOW_TOKEN || !SITE_ID) {
      return res.status(400).json({
        success: false,
        error: 'Missing environment variables',
        message: 'WEBFLOW_API_TOKEN and WEBFLOW_SITE_ID must be set'
      });
    }

    const results = {
      timestamp: new Date().toISOString(),
      siteId: SITE_ID,
      collections: [],
      error: null
    };

    // Test Webflow API connection by getting collections
    console.log('Testing Webflow API connection...');
    const collectionsResponse = await fetch(`https://api.webflow.com/sites/${SITE_ID}/collections`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
        'Accept-Version': '1.0.0',
        'Content-Type': 'application/json'
      }
    });

    if (!collectionsResponse.ok) {
      throw new Error(`Webflow API error: ${collectionsResponse.status} ${collectionsResponse.statusText}`);
    }

    const collectionsData = await collectionsResponse.json();
    
    // Process collections data
    if (collectionsData && Array.isArray(collectionsData)) {
      results.collections = collectionsData.map(collection => ({
        id: collection._id,
        name: collection.name,
        slug: collection.slug,
        fields: collection.fields ? collection.fields.length : 0,
        items: collection.itemCount || 0
      }));
    }

    // Look for Bills collection specifically
    const billsCollection = results.collections.find(c => 
      c.name.toLowerCase().includes('bill') || 
      c.slug.toLowerCase().includes('bill')
    );

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      webflow: {
        siteId: SITE_ID,
        tokenPresent: !!WEBFLOW_TOKEN,
        collectionsFound: results.collections.length
      },
      collections: results.collections,
      billsCollection: billsCollection || null,
      nextSteps: billsCollection 
        ? [`Found Bills collection: ${billsCollection.id}`, 'Ready to create sync endpoint']
        : ['Create a Bills collection in Webflow first', 'Then run this test again']
    });

  } catch (error) {
    console.error('Webflow test failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Webflow API test failed',
      timestamp: new Date().toISOString()
    });
  }
}
