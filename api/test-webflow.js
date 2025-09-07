export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    const siteId = process.env.WEBFLOW_SITE_ID;
    
    if (!token || !siteId) {
      return res.json({ error: 'Missing environment variables' });
    }
    
    return res.json({ 
      success: true, 
      message: 'Environment variables found',
      hasToken: !!token,
      hasSiteId: !!siteId
    });
    
  } catch (error) {
    return res.json({ error: error.message });
  }
}
