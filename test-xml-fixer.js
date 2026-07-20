const assert = require('assert');
const { validateStructuralIntegrity } = require('./fixer/validateStructuralIntegrity');

function runTests() {
  console.log("Running XML Structural Integrity tests...");

  const originalXml = `
  <bpmn2:definitions>
    <bpmn2:process id="Process_1">
      <bpmn2:sendTask id="Task_1" name="Send Task 1">
        <bpmn2:extensionElements>
          <custom:property name="host" value="api.coinbase.om" />
          <custom:property name="port" value="443" />
        </bpmn2:extensionElements>
      </bpmn2:sendTask>
    </bpmn2:process>
  </bpmn2:definitions>
  `;

  const validProposedXml = `
  <bpmn2:definitions>
    <bpmn2:process id="Process_1">
      <bpmn2:sendTask id="Task_1" name="Send Task 1">
        <bpmn2:extensionElements>
          <custom:property name="host" value="api.coinbase.com" />
          <custom:property name="port" value="443" />
        </bpmn2:extensionElements>
      </bpmn2:sendTask>
    </bpmn2:process>
  </bpmn2:definitions>
  `;

  // Valid change should pass
  assert(validateStructuralIntegrity(originalXml, validProposedXml), "Expected valid structural change to pass");

  const invalidProposedXml_addedNode = `
  <bpmn2:definitions>
    <bpmn2:process id="Process_1">
      <bpmn2:sendTask id="Task_1" name="Send Task 1">
        <bpmn2:extensionElements>
          <custom:property name="host" value="api.coinbase.com" />
          <custom:property name="port" value="443" />
          <custom:property name="new_prop" value="true" />
        </bpmn2:extensionElements>
      </bpmn2:sendTask>
    </bpmn2:process>
  </bpmn2:definitions>
  `;

  // Added node should fail
  assert(!validateStructuralIntegrity(originalXml, invalidProposedXml_addedNode), "Expected added node to fail structural check");

  const invalidProposedXml_changedNesting = `
  <bpmn2:definitions>
    <bpmn2:process id="Process_1">
      <bpmn2:sendTask id="Task_1" name="Send Task 1">
      </bpmn2:sendTask>
      <bpmn2:extensionElements>
        <custom:property name="host" value="api.coinbase.om" />
        <custom:property name="port" value="443" />
      </bpmn2:extensionElements>
    </bpmn2:process>
  </bpmn2:definitions>
  `;

  // Changed nesting should fail
  assert(!validateStructuralIntegrity(originalXml, invalidProposedXml_changedNesting), "Expected changed nesting to fail structural check");

  console.log("All structural integrity tests passed!");
}

runTests();
