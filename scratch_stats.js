const db = require('./database/index');

const exceptionSubprocesses = db.prepare("SELECT artifact_id, parsed_json FROM parsed_metadata WHERE type = 'IFlow'").all();
let totalExceptions = 0;
let iflowsWithExceptions = [];

for (const row of exceptionSubprocesses) {
    const data = JSON.parse(row.parsed_json);
    if (data.hasExceptionSubprocess) {
        totalExceptions += data.exceptionSubprocessCount;
        iflowsWithExceptions.push(row.artifact_id);
    }
}

console.log('--- Exception Subprocess Stats ---');
console.log(`Total IFlows with exception subprocesses: ${iflowsWithExceptions.length}`);
console.log(`Total exception subprocesses across tenant: ${totalExceptions}`);
console.log('IFlows:', iflowsWithExceptions.join(', '));

const sample = db.prepare("SELECT parsed_json FROM parsed_metadata WHERE type = 'IFlow' AND artifact_id = 'Assignment_HTTP_Request_Reply_with_Exception_Handling'").get();
if (sample) {
    console.log('\n--- Sample Parsed JSON ---');
    console.log(JSON.stringify(JSON.parse(sample.parsed_json), null, 2));
} else {
    const anotherSample = db.prepare("SELECT artifact_id, parsed_json FROM parsed_metadata WHERE type = 'IFlow' LIMIT 1").get();
    console.log('\n--- Sample Parsed JSON ---');
    console.log('Artifact:', anotherSample.artifact_id);
    console.log(JSON.stringify(JSON.parse(anotherSample.parsed_json), null, 2));
}
