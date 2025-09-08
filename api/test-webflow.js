export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    
    if (!token) {
      return res.json({ error: 'Missing API token' });
    }
    
    // Test user endpoint with corrected header case
    const response = await fetch('https://api.webflow.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept-Version': '1.0.0'
      }
    });
    
    const data = await response.json();
    
    return res.json({ 
      success: response.ok,
      status: response.status,
      webflowResponse: data,
      message: response.ok ? 'User endpoint successful' : 'User endpoint failed'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
