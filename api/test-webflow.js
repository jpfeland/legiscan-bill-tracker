export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    
    if (!token) {
      return res.json({ error: 'Missing API token' });
    }
    
    // Test with API version 2.0.0
    const response = await fetch('https://api.webflow.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'accept-version': '2.0.0'
      }
    });
    
    const data = await response.json();
    
    return res.json({ 
      success: response.ok,
      status: response.status,
      webflowResponse: data,
      message: response.ok ? 'User endpoint successful with v2.0.0' : 'Still failing with v2.0.0'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
