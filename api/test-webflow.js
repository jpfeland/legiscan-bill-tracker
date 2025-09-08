export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    
    if (!token) {
      return res.json({ error: 'Missing API token' });
    }
    
    // Back to API version 1.0.0 as the error specified
    const response = await fetch('https://api.webflow.com/user', {
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
      message: response.ok ? 'Success with v1.0.0!' : 'Still failing with v1.0.0'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
