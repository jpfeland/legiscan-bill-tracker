export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    if (!token) {
      return res.json({ error: 'Missing API token' });
    }
    
    // Try the sites endpoint instead of /user
    const response = await fetch('https://api.webflow.com/sites', {
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
      message: response.ok ? 'Sites endpoint successful!' : 'Sites endpoint failed',
      endpoint: '/sites'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
