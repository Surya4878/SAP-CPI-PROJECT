const axios = require('axios');
const Bottleneck = require('bottleneck');
const config = require('../config');
const auth = require('../auth');

const limiter = new Bottleneck({
  maxConcurrent: config.maxConcurrentDownloads,
  minTime: Math.ceil(1000 / config.rateLimit) // e.g. 5 req/s = 200ms
});

// Configure the single allowed axios instance
const apiClient = axios.create({
  baseURL: config.apiHost,
});

// Interceptor to inject token and track timing
apiClient.interceptors.request.use(async (reqConfig) => {
  const token = await auth.getToken();
  reqConfig.headers['Authorization'] = `Bearer ${token}`;
  
  reqConfig.metadata = reqConfig.metadata || {};
  reqConfig.metadata.startTime = Date.now();
  reqConfig.metadata.retryCount = reqConfig.metadata.retryCount || 0;
  
  return reqConfig;
});

// Interceptor to log responses
apiClient.interceptors.response.use(
  (response) => {
    const duration = Date.now() - response.config.metadata.startTime;
    const retryInfo = response.config.metadata.retryCount > 0 ? ` (retries: ${response.config.metadata.retryCount})` : '';
    console.log(`[Queue] HTTP ${response.status} | ${response.config.method.toUpperCase()} ${response.config.url} | ${duration}ms${retryInfo}`);
    return response;
  },
  (error) => {
    const duration = error.config && error.config.metadata ? Date.now() - error.config.metadata.startTime : 0;
    const status = error.response ? error.response.status : 'ERR';
    const method = error.config ? error.config.method.toUpperCase() : 'UNKNOWN';
    const url = error.config ? error.config.url : 'UNKNOWN';
    const retryInfo = error.config && error.config.metadata && error.config.metadata.retryCount > 0 
      ? ` (retries: ${error.config.metadata.retryCount})` : '';
    
    console.error(`[Queue] HTTP ${status} | ${method} ${url} | ${duration}ms${retryInfo} | ${error.message}`);
    throw error;
  }
);

// Bottleneck failed event for retries (429 and 401)
limiter.on('failed', async (error, jobInfo) => {
  const status = error.response?.status;
  const reqConfig = error.config;
  
  if (reqConfig && reqConfig.metadata) {
    reqConfig.metadata.retryCount++;
  }

  // Handle 429 Too Many Requests
  if (status === 429) {
    const maxRetries = 5;
    const current429Retries = reqConfig._retries429 || 0;
    
    if (current429Retries < maxRetries) {
      reqConfig._retries429 = current429Retries + 1;
      const backoffDelay = (250 * Math.pow(2, current429Retries)) + (Math.random() * 100);
      console.warn(`[Queue] 429 Too Many Requests for ${reqConfig.url}. Retrying in ${Math.round(backoffDelay)}ms (Attempt ${reqConfig._retries429}/${maxRetries})`);
      return backoffDelay;
    }
  }
  
  // Handle 401 Unauthorized
  if (status === 401) {
    if (reqConfig && !reqConfig._retried401) {
      console.warn(`[Queue] 401 Unauthorized for ${reqConfig.url}. Refreshing token and retrying...`);
      await auth.refreshToken();
      reqConfig._retried401 = true;
      return 0; // retry immediately
    }
  }
  
  // Do not retry anything else, just fail the job
});

/**
 * The only exported interface for making tenant API requests.
 * By exporting this class and NOT exporting the `axios` instance, 
 * we guarantee all outbound requests pass through the bottleneck limiter.
 */
class RequestQueue {
  async request(reqConfig) {
    return limiter.schedule(() => apiClient.request(reqConfig));
  }

  async get(url, reqConfig = {}) {
    return this.request({ ...reqConfig, method: 'GET', url });
  }

  async post(url, data, reqConfig = {}) {
    return this.request({ ...reqConfig, method: 'POST', url, data });
  }
  
  async put(url, data, reqConfig = {}) {
    return this.request({ ...reqConfig, method: 'PUT', url, data });
  }
  
  async delete(url, reqConfig = {}) {
    return this.request({ ...reqConfig, method: 'DELETE', url });
  }
}

module.exports = new RequestQueue();
