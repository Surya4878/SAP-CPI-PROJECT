require('dotenv').config();

const config = {
  apiHost: process.env.API_HOST,
  tokenUrl: process.env.TOKEN_URL,
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  rateLimit: parseInt(process.env.RATE_LIMIT || '5', 10),
  maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3', 10),
};

// Basic validation
if (!config.apiHost || !config.tokenUrl || !config.clientId || !config.clientSecret) {
  console.warn('Warning: Missing essential configuration variables. Check your .env file.');
}

module.exports = config;
