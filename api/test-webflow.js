// /api/test-webflow.js
// Test Webflow v2 API connection and get collection info

export default async function handler(req, res) {
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
      site: null,
      collections: [],
      error: null
    };

    // Test 1: Get site information
    console.log('Testing Webflow v2 API - Site info...');
    const siteResponse = await fetch(`https://api.webflow.com/v2/sites/${SITE_ID}`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_TOKEN}`
      }
    });

    if (!siteResponse.ok) {
      throw new Error(`Site API error: ${siteResponse.status} ${siteResponse.statusText}`);
    }

    const siteData = await siteResponse.json();
    results.site = {
      id: siteData.id,
      displayName: siteData.displayName,
      shortName: siteData.shortName,
      workspaceId: siteData.workspaceId,
      timeZone: siteData.timeZone,
      lastUpdated: siteData.lastUpdated
    };

    // Test 2: Get collections
    console.log('Testing Webflow v2 API - Collections...');
    const collectionsResponse = await fetch(`https://api.webflow.com/v2/sites/${SITE_ID}/collections`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_TOKEN}`
      }
    });

    if (!collectionsResponse.ok) {
      throw new Error(`Collections API error: ${collectionsResponse.status} ${collectionsResponse.statusText}`);
    }

    const collectionsData = await collectionsResponse.json();
    
    // Process collections data
    if (collectionsData && collectionsData.collections) {
      results.collections = collectionsData.collections.map(collection => ({
        id: collection.id,
        displayName: collection.displayName,
        singularName: collection.singularName,
        slug: collection.slug,
        fields: collection.fields ? collection.fields.length : 0
      }));
    }

    // Look for Bills collection specifically
    const billsCollection = results.collections.find(c => 
      c.displayName.toLowerCase().includes('bill') || 
      c.singularName.toLowerCase().includes('bill') ||
      c.slug.toLowerCase().includes('bill')
    );

    return res.status(200).json({
      success: true,
      timestamp: results.timestamp,
      webflow: {
        apiVersion: 'v2',
        siteId: SITE_ID,
        tokenPresent: !!WEBFLOW_TOKEN,
        collectionsFound: results.collections.length
      },
      site: results.site,
      collections: results.collections,
      billsCollection: billsCollection || null,
      nextSteps: billsCollection 
        ? [
            `Found Bills collection: ${billsCollection.id}`, 
            'Ready to create sync endpoint',
            `Collection has ${billsCollection.fields} fields`
          ]
        : [
            'Create a Bills collection in Webflow first',
            'Add fields: Bill Number (text), Title (long text)',
            'Then run this test again'
          ]
    });

  } catch (error) {
    console.error('Webflow test failed:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      message: 'Webflow v2 API test failed',
      timestamp: new Date().toISOString()
    });
  }
}
