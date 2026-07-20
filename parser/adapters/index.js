function propertiesToMap(extensionElements) {
  const map = {};
  if (!extensionElements || !extensionElements['ifl:property']) return map;
  
  const props = Array.isArray(extensionElements['ifl:property']) 
    ? extensionElements['ifl:property'] 
    : [extensionElements['ifl:property']];
    
  for (const p of props) {
    if (p.key) {
      map[p.key] = p.value || null;
    }
  }
  return map;
}

function parseAdapter(extensionElements, direction) {
  const props = propertiesToMap(extensionElements);
  const type = props['ComponentType'] || 'Unknown';
  
  const result = {
    type,
    direction,
    address: null,
    config: {}
  };

  // Specific extractions per adapter
  switch (type) {
    case 'ProcessDirect':
      result.address = props['address'];
      break;
    case 'HTTPS':
    case 'HTTP':
      result.address = props['httpAddressWithoutQuery'] || props['address'] || props['url'];
      result.config.method = props['httpMethod'];
      result.config.auth = props['authenticationMethod'];
      break;
    case 'SFTP':
    case 'PollingSFTP':
    case 'FTP':
      result.address = props['host'];
      result.config.path = props['path'];
      result.config.auth = props['authentication'];
      result.config.userCredential = props['userCredentialAlias'];
      break;
    case 'JMS':
      result.address = props['QueueName_outbound'] || props['QueueName_inbound'] || props['QueueName'];
      break;
    case 'JDBC':
      result.address = props['jdbcDataSourceAlias'];
      break;
    case 'Mail':
      result.address = props['server'];
      result.config.userCredential = props['user'];
      break;
    case 'SOAP':
      result.address = props['address'];
      break;
    case 'HCIOData':
      result.address = props['address'];
      result.config.operation = props['operation'];
      break;
    default:
      // Unknown adapters get graceful fallback: we capture what we can
      result.config.rawProperties = props;
      break;
  }

  return result;
}

module.exports = {
  parseAdapter,
  propertiesToMap
};
