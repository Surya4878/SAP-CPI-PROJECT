const { XMLParser } = require('fast-xml-parser');
const { parseAdapter, propertiesToMap } = require('./adapters');

const PARSER_VERSION = 4; // Bump version to catch pallet properties

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

function parseEscapedTable(escapedXml) {
  if (!escapedXml) return null;
  // Some values might just be plain strings, but if it starts with <row>, it's a table
  if (typeof escapedXml === 'string' && escapedXml.includes('<row>')) {
    try {
      // Wrap it in a root tag so it's valid XML
      const xmlStr = `<root>${escapedXml}</root>`;
      const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });
      const parsed = parser.parse(xmlStr);
      
      let rows = parsed.root.row;
      if (!Array.isArray(rows)) rows = [rows];
      
      return rows.map(r => {
        const obj = {};
        let cells = r.cell;
        if (!Array.isArray(cells)) cells = [cells];
        
        for (const cell of cells) {
          if (cell['@_id']) {
            obj[cell['@_id']] = cell['#text'] !== undefined ? cell['#text'] : '';
          }
        }
        return obj;
      }).filter(o => Object.keys(o).length > 0);
    } catch (err) {
      return escapedXml; // If it fails to parse, return the string
    }
  }
  return escapedXml;
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
      const step = {
        type: props.activityType,
        stepKey: element['@_name'] || props.stepKey || null
      };

      // Extract specific properties for the step
      if (props.propertyTable) step.properties = parseEscapedTable(props.propertyTable);
      if (props.headerTable) step.headers = parseEscapedTable(props.headerTable);
      if (props.wrapContent) step.wrapContent = props.wrapContent;

      steps.push(step);

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
