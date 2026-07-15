const { XMLParser } = require('fast-xml-parser');
const parser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: true });
const parsed = parser.parse('<node id="1" name="test"></node>');
console.log(parsed);
