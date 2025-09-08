export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    
    if (!token) {
      return res.json({ error: 'Missing API token' });
    }
    
    // Try without any version header
    const response = await fetch('https://api.webflow.com/user', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const data = await response.json();
    
    return res.json({ 
      success: response.ok,
      status: response.status,
      webflowResponse: data,
      message: response.ok ? 'Success without version header!' : 'Still failing without version'
    });
    
  } catch (error) {
    return res.json({ 
      success: false,
      error: error.message 
    });
  }
}
