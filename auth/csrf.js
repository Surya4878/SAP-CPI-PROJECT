const queue = require('../queue/index');

let cachedCsrfToken = null;
let cachedCookies = null;
let lastFetchTime = 0;
// CSRF tokens in CPI are typically valid for at least 15-30 minutes of session activity.
const TTL_MS = 15 * 60 * 1000;

/**
 * Fetches and caches a CSRF token and the associated session cookies.
 * Reuses the cached credentials if they are less than TTL_MS old.
 */
async function getCSRFCredentials(forceRefresh = false) {
  if (!forceRefresh && cachedCsrfToken && cachedCookies && (Date.now() - lastFetchTime < TTL_MS)) {
    return { csrfToken: cachedCsrfToken, cookies: cachedCookies };
  }

  // To fetch CSRF safely across any CPI tenant, we issue a GET to $metadata with X-CSRF-Token: Fetch
  const res = await queue.get('/$metadata', {
    headers: {
      'X-CSRF-Token': 'Fetch'
    }
  });

  const csrfToken = res.headers['x-csrf-token'];
  const cookies = res.headers['set-cookie'];

  if (!csrfToken) {
    throw new Error('Failed to fetch CSRF Token from API.');
  }

  cachedCsrfToken = csrfToken;
  // Parse and format cookies to be sent back (just take the array elements and join them)
  cachedCookies = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
  lastFetchTime = Date.now();

  return { csrfToken: cachedCsrfToken, cookies: cachedCookies };
}

module.exports = {
  getCSRFCredentials
};
