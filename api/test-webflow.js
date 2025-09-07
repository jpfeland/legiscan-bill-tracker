export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    const siteId = process.env.WEBFLOW_SITE_ID;
    
    if (!token || !siteId) {
      return res.json({ error: 'Missing environment variables' });
    }
    
    // Test basic Webflow API connection
    const response = await fetch(`https://api.webflow.com/sites/${siteId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'accept-version': '1.0.0'
      }
    });
    
    const data = await response.json();
    
    return res.json({ 
      success: response.ok,
      status: response.status,
      webflowResponse: data,
      message: response.ok ? 'Webflow connection successful' : 'Webflow API error'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
