const axios = require('axios');

// Token caching for OAuth client credentials flow
let cachedToken = null;
let tokenExpiresAt = 0;

async function getBearerToken() {
  // 1. Prefer static token if provided
  if (process.env.CPI_BEARER_TOKEN) {
    return process.env.CPI_BEARER_TOKEN;
  }

  // 2. Fallback to client credentials flow
  const clientId = process.env.CPI_CLIENT_ID;
  const clientSecret = process.env.CPI_CLIENT_SECRET;
  const tokenUrl = process.env.CPI_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error('No CPI_BEARER_TOKEN provided, and missing OAuth credentials (CPI_CLIENT_ID, CPI_CLIENT_SECRET, CPI_TOKEN_URL) in .env');
  }

  // Check cache
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  console.log('[CPI-MCP] Fetching new OAuth token...');
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  const response = await axios.post(tokenUrl, 'grant_type=client_credentials', {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  cachedToken = response.data.access_token;
  // Subtract 60 seconds as a safety buffer
  tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000;
  
  return cachedToken;
}

module.exports = async (req, res) => {
  // Hard enforcement: Only allow GET requests (Read-Only proxy)
  if (req.method !== 'GET') {
    console.warn(`[CPI-MCP] BLOCKED mutating request: ${req.method} ${req.path}`);
    return res.status(405).json({
      error: 'Method Not Allowed',
      message: 'This MCP server is configured as a Read-Only proxy. Mutating requests (POST, PUT, DELETE, PATCH) are strictly prohibited for security and auditing reasons.'
    });
  }

  const tenantHost = process.env.CPI_TENANT_HOST;
  if (!tenantHost) {
    return res.status(500).json({ error: 'CPI_TENANT_HOST is not configured in .env' });
  }

  // Extract the path after /cpi
  const targetPath = req.path.replace(/^\/cpi/, '');
  
  // Construct full target URL (handling query strings properly)
  let targetUrl = `https://${tenantHost}/api/v1${targetPath}`;
  
  // Re-append query parameters
  const queryStr = new URLSearchParams(req.query).toString();
  if (queryStr) {
    targetUrl += `?${queryStr}`;
  }

  try {
    const token = await getBearerToken();

    console.log(`[CPI-MCP] Proxying GET -> ${targetUrl}`);
    
    const response = await axios({
      method: 'GET',
      url: targetUrl,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
      // Return binary streams for specific zip downloads or attachments
      responseType: targetUrl.endsWith('/$value') ? 'arraybuffer' : 'json'
    });

    // Forward the headers and response
    res.status(response.status);
    res.set('Content-Type', response.headers['content-type']);
    res.send(response.data);

  } catch (error) {
    console.error(`[CPI-MCP] Proxy Error for ${targetUrl}:`, error.message);
    if (error.response) {
      res.status(error.response.status).send(error.response.data);
    } else {
      res.status(500).json({ error: 'Proxy Request Failed', details: error.message });
    }
  }
};
