const { XMLParser } = require('fast-xml-parser');

const PARSER_VERSION = 1;

function parseValueMapping(xmlStr) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: true,
  });

  const parsed = parser.parse(xmlStr);
  const mappings = [];

  if (parsed.vm && parsed.vm.group) {
    // fast-xml-parser returns an object if there's only one group, array if multiple
    const groups = Array.isArray(parsed.vm.group) ? parsed.vm.group : [parsed.vm.group];
    
    for (const group of groups) {
      if (group.entry) {
        const entries = Array.isArray(group.entry) ? group.entry : [group.entry];
        // Convert to a structured object for this group
        const groupMap = {};
        for (const entry of entries) {
           const key = `${entry.agency}:${entry.schema}`;
           groupMap[key] = entry.value;
        }
        mappings.push({ id: group['@_id'], entries: groupMap });
      }
    }
  }

  return {
    mappings
  };
}

module.exports = {
  parseValueMapping,
  PARSER_VERSION
};
