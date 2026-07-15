const axios = require('axios');
const config = require('../config');

class AuthModule {
  constructor() {
    this.token = null;
    this.expiresAt = null;
    this.tokenPromise = null;
  }

  /**
   * Retrieves a valid token. If the current token is expired or about to expire,
   * it will automatically refresh it. Concurrent requests for a token will share
   * the same promise to avoid redundant network calls.
   */
  async getToken(forceRefresh = false) {
    if (!forceRefresh && this.token && this.expiresAt && Date.now() < this.expiresAt) {
      return this.token;
    }

    // If a refresh is already in progress, wait for it
    if (this.tokenPromise) {
      return this.tokenPromise;
    }

    this.tokenPromise = this._fetchToken()
      .then((token) => {
        this.tokenPromise = null;
        return token;
      })
      .catch((error) => {
        this.tokenPromise = null;
        throw error;
      });

    return this.tokenPromise;
  }

  async _fetchToken() {
    try {
      const authString = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
      
      const response = await axios.post(`${config.tokenUrl}/oauth/token`, 'grant_type=client_credentials', {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${authString}`,
        }
      });

      const { access_token, expires_in } = response.data;
      
      this.token = access_token;
      // Refresh 5 minutes before actual expiry, or if expires_in is very short, halfway through
      const bufferMs = Math.min(5 * 60 * 1000, (expires_in * 1000) / 2); 
      this.expiresAt = Date.now() + (expires_in * 1000) - bufferMs;

      return this.token;
    } catch (error) {
      console.error('Failed to fetch OAuth token:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Forces a token refresh. Useful when a 401 is encountered despite our cached expiry.
   */
  async refreshToken() {
    return this.getToken(true);
  }
}

module.exports = new AuthModule();
