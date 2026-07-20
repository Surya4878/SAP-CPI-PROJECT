const { XMLParser } = require('fast-xml-parser');

// Recursively strip primitive string/number/boolean values from an object/array, replacing them with empty strings.
function stripValues(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => stripValues(item));
  } else if (obj !== null && typeof obj === 'object') {
    const newObj = {};
    for (const key of Object.keys(obj)) {
      newObj[key] = stripValues(obj[key]);
    }
    return newObj;
  } else {
    // Primitive value: string, number, boolean, null, undefined
    return "";
  }
}

/**
 * Validates that two XML strings have the exact same structure (elements, attributes, order, nesting),
 * differing only in text/attribute values.
 * Returns true if structurally identical, false otherwise.
 */
function validateStructuralIntegrity(originalXml, proposedXml) {
  const options = {
    ignoreAttributes: false,
    parseAttributeValue: false,
    allowBooleanAttributes: true
  };
  
  const parser = new XMLParser(options);
  
  let originalTree, proposedTree;
  try {
    originalTree = parser.parse(originalXml);
    proposedTree = parser.parse(proposedXml);
  } catch (err) {
    console.error("XML Parsing failed during structural validation:", err.message);
    return false;
  }

  const originalStripped = stripValues(originalTree);
  const proposedStripped = stripValues(proposedTree);

  // Compare shapes by stringifying the stripped structures.
  // Because JS object key order is deterministic in fast-xml-parser, this is a safe deep strict equality check.
  const originalJson = JSON.stringify(originalStripped);
  const proposedJson = JSON.stringify(proposedStripped);

  return originalJson === proposedJson;
}

module.exports = {
  validateStructuralIntegrity,
  stripValues // exported for testing if needed
};
