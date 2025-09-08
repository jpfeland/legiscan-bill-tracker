export default async function handler(req, res) {
  try {
    const token = process.env.WEBFLOW_API_TOKEN;
    if (!token) return res.status(400).json({ error: 'Missing API token' });

    const response = await fetch('https://api.webflow.com/v2/sites', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await response.json();

    return res.status(response.ok ? 200 : response.status).json({
      success: response.ok,
      status: response.status,
      webflowResponse: data,
      message: response.ok ? 'v2 sites endpoint successful' : 'v2 sites endpoint failed',
      endpoint: '/v2/sites'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error) });
  }
}
