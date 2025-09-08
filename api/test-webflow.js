export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    const collectionId = "68b8b074ed73a91391908240"; // Your Bills collection ID
    
    if (!token) {
      return res.status(400).json({ error: 'Missing API token' });
    }
    
    // Get detailed collection info including fields
    const response = await fetch(`https://api.webflow.com/v2/collections/${collectionId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    const data = await response.json();
    
    return res.json({
      success: response.ok,
      status: response.status,
      collection: data,
      fieldsCount: data.fields ? data.fields.length : 0,
      fieldNames: data.fields ? data.fields.map(f => f.displayName) : []
    });
    
  } catch (error) {
    return res.json({ success: false, error: error.message });
  }
}
