const { XMLParser } = require('fast-xml-parser');
const { parseAdapter, propertiesToMap } = require('./adapters');

const PARSER_VERSION = 2; // Bump version so it reparses!

function findParentsWithProperty(obj, propName, result = []) {
  if (obj === null || typeof obj !== 'object') return result;
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      findParentsWithProperty(item, propName, result);
    }
  } else {
    if (obj.hasOwnProperty(propName)) {
      result.push(obj);
    }
    for (const k of Object.keys(obj)) {
      if (k === propName) continue;
      findParentsWithProperty(obj[k], propName, result);
    }
  }
  return result;
}

function parseIFlow(xmlStr) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: true,
  });

  const parsed = parser.parse(xmlStr);
  
  const adapters = [];
  const steps = [];
  const references = [];
  let exceptionSubprocessCount = 0;

  // Find all objects that have extensionElements
  const allElements = findParentsWithProperty(parsed, 'bpmn2:extensionElements');

  for (const element of allElements) {
    const extElements = element['bpmn2:extensionElements'];
    const props = propertiesToMap(extElements);
    
    // Is it a MessageFlow (Adapter)?
    // Usually messageFlows have a sourceRef and targetRef in the object, 
    // but the easiest way to identify an adapter is if props.ComponentType exists
    if (props.ComponentType) {
      // Determine direction from props.direction or props.ifl:type
      let direction = props.direction || props['ifl:type'] || 'Unknown';
      if (direction === 'EndpointSender' || direction === 'SenderChannel') direction = 'Sender';
      if (direction === 'EndpointRecevier' || direction === 'ReceiverChannel') direction = 'Receiver';
      
      const adapter = parseAdapter(extElements, direction);
      adapters.push(adapter);
      
      // Capture references like ProcessDirect or JMS
      if (['ProcessDirect', 'JMS'].includes(adapter.type) && adapter.address) {
         references.push({ type: adapter.type, address: adapter.address });
      }
    }
    
    // Is it a process step?
    if (props.activityType) {
      steps.push({
        type: props.activityType,
        stepKey: element['@_name'] || props.stepKey || null
      });

      // Special handling for Exception Subprocess
      if (props.activityType === 'ErrorEventSubProcessTemplate') {
        exceptionSubprocessCount++;
      }
      
      // Capture Script/Mapping/ValueMapping references
      if (props.activityType === 'Script' && props.script) {
         references.push({ type: 'Script', path: props.script });
      }
      if (props.activityType === 'Mapping') {
         if (props.mappinguri) references.push({ type: 'MessageMapping', path: props.mappinguri });
      }
      if (props.activityType === 'contentEnricherWithLookup') {
         if (props.queryMap) references.push({ type: 'Lookup', path: props.queryMap });
      }
    }
  }

  return {
    adapters,
    steps,
    references,
    exceptionSubprocessCount,
    hasExceptionSubprocess: exceptionSubprocessCount > 0
  };
}

module.exports = {
  parseIFlow,
  PARSER_VERSION
};
