const axios = require('axios');
require('dotenv').config();
const { getCSRFCredentials } = require('./auth/csrf');

async function test() {
  const { csrfToken, cookies } = await getCSRFCredentials();
  const url = process.env.API_HOST + "/itspaces/odata/1.0/workspace.svc/ContentPackages('Adopters')/Artifacts?$format=json";
  try {
    const r = await axios.get(url, { headers: { Cookie: cookies, 'X-CSRF-Token': csrfToken } });
    console.log(JSON.stringify(r.data.d.results.filter(x => x.Name === 'JDBC_Adapter'), null, 2));
  } catch(e) {
    console.log('Error:', e.response ? e.response.status : e.message);
  }
}
test();
