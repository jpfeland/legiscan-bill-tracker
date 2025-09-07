const collectionsResponse = await fetch(`https://api.webflow.com/sites/${SITE_ID}`, {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${WEBFLOW_TOKEN}`,
    'accept-version': '1.0.0'
  }
});
