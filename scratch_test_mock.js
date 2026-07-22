const { generateValueFixForXml } = require('./fixer/generateValueFix');
require('dotenv').config();

async function testMock() {
  const mockIflw = `
    <bpmn2:definitions>
      <bpmn2:process>
        <bpmn2:callActivity id="CallActivity_1" name="Content Modifier">
          <bpmn2:extensionElements>
            <ifl:property>
              <key>MyHeader</key>
              <value>WrronngValue</value>
            </ifl:property>
          </bpmn2:extensionElements>
        </bpmn2:callActivity>
      </bpmn2:process>
    </bpmn2:definitions>
  `;

  const issueContext = 'java.lang.IllegalArgumentException: Invalid header value "WrronngValue" for MyHeader, expected "CorrectValue"';

  try {
    const result = await generateValueFixForXml(mockIflw, issueContext, "Mock Metadata", "No prior reviews");
    console.log("LLM generated fix successfully:", result);
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testMock();
