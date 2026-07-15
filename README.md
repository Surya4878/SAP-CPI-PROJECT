# SAP CPI Metadata Discovery Engine

## Overview
This engine is a read-only metadata ingestion and relationship-mapping layer for SAP Cloud Platform Integration (CPI). It recursively crawls the SAP CPI OData API to discover, download, and catalog integration packages, runtime artifacts, configurations, and mapping schemas into a highly structured local SQLite database. It extracts the raw BPMN XML from discovered artifacts, builds a relationship graph of cross-artifact dependencies and external endpoints, and maintains an idempotent, incremental state snapshot of the entire tenant.

## Setup
### Prerequisites
- Node.js (v18+)
- SQLite3

### Environment Variables
You must configure the `.env` file at the root of the project. See `.env.example` for the required keys.
```env
CPI_HOST=https://your-tenant.it-cpi012.cfapps.eu10.hana.ondemand.com/api/v1
CPI_CLIENT_ID=your_client_id
CPI_CLIENT_SECRET=your_client_secret
CPI_TOKEN_URL=https://your-tenant.authentication.eu10.hana.ondemand.com/oauth/token
```

### Running Discovery
To run the full end-to-end sync pipeline, simply execute:
```bash
node discovery/run.js
```
This is fully idempotent. If no data has changed on the tenant, a subsequent run will gracefully skip all downloads and parsing, logging a clean state update in seconds.

## Architecture
The sync loop executes the following 9 units sequentially:
1. **Initialize Sync Run**: Creates a new record in `sync_runs` to track the state of the ingestion process.
2. **Package Discovery**: Discovers Integration Packages and inserts/updates records in `packages`.
3. **Artifact Discovery**: Iterates over all discovered packages and discovers designtime artifacts (IFlows, ValueMappings, ScriptCollections, etc.), updating `artifacts`.
4. **Cascade Soft-Deletes**: Identifies and flags any packages or artifacts missing from the current API sync run as deleted.
5. **Artifact Downloader**: Downloads the Base64 ZIP payloads of any new or version-changed artifacts, unpacking and extracting all internal files into the `resources` table.
6. **BPMN & XML Parser**: Parses `.iflw` XML and `.xml` value mappings from the `resources` table into clean, structured JSON representations inside `parsed_metadata`.
7. **Custom Tags Configuration**: Discovers custom tag hierarchies from the tenant API and populates `custom_tags`.
8. **Relationship Engine**: Analyzes the parsed JSON BPMN models to deduce adapter topologies and cross-artifact references (e.g. ProcessDirect and JMS), populating the `relationships` table.
9. **Runtime Discovery**: Connects to the runtime nodes to ascertain the deployment status and error state of deployed artifacts, populating `runtime_status` and `service_endpoints`.

## Database Schema (`data/cpi_metadata.db`)
All data is stored locally in SQLite. Below is the purpose and behavior of every table:

- **`packages`**: Represents an Integration Package.
  - Columns: `id`, `name`, `version`, `created_by`, `created_at`, `modified_by`, `modified_at`, `is_deleted`, `last_synced_at`
  - Classification: Incremental (Idempotent updates). Soft-deleted if it disappears from the API.
- **`artifacts`**: Represents a designtime artifact (e.g., IFlow, ValueMapping).
  - Columns: `id`, `package_id`, `source_id`, `name`, `type`, `version`, `created_by`, `created_at`, `modified_by`, `modified_at`, `is_deleted`, `last_synced_at`
  - Classification: Incremental. Classified via `source_id` + `version`. Soft-deleted if it disappears from the API.
- **`resources`**: Represents a file extracted from an artifact's ZIP payload.
  - Columns: `id`, `artifact_id`, `file_path`, `file_type`, `file_size`, `content`, `extracted_at`
  - Classification: Full-rebuild-per-artifact. When an artifact changes, its existing resources are wiped and re-extracted. `content` is only populated for target file extensions (`.iflw`, `value_mapping.xml`).
- **`parsed_metadata`**: Represents the structured JSON output of parsed XML BPMN models or mapping files.
  - Columns: `artifact_id`, `parser_version`, `parsed_content`, `parsed_at`, `error_message`
  - Classification: Incremental. Re-parsed only if the artifact has changed or the `parser_version` in code is bumped.
- **`relationships`**: Represents a directed edge mapping (e.g. Sender Adapter, Receiver Adapter, ProcessDirect chain).
  - Columns: `id`, `source_artifact_id`, `target_artifact_id`, `target_system`, `relationship_type`, `direction`, `adapter_type`, `step_name`, `address`
  - Classification: Full-rebuild-per-run. Safely truncates and rebuilds every sync run.
- **`runtime_status`**: Represents the deployment status (e.g., STARTED, ERROR) of an artifact on the runtime nodes.
  - Columns: `id`, `artifact_id`, `status`, `version`, `type`, `deployed_on`, `error_info`, `last_checked_at`, `sync_run_id`
  - Classification: Full-rebuild-per-run.
- **`service_endpoints`**: Represents the HTTP routes currently exposed by deployed runtime artifacts.
  - Columns: `id`, `artifact_id`, `name`, `address`, `last_checked_at`, `sync_run_id`
  - Classification: Full-rebuild-per-run.
- **`custom_tags`**: Represents the tenant's Custom Tags hierarchy configuration.
  - Columns: `id`, `tag_name`, `tag_value`, `parent_tag_id`, `last_synced_at`
  - Classification: Full-rebuild-per-run.
- **`sync_runs`**: Represents a historical audit log of every sync execution and its metrics.
  - Columns: `id`, `started_at`, `completed_at`, `mode`, `packages_new`, `packages_changed`, `packages_deleted`, `artifacts_new`, `artifacts_changed`, `artifacts_deleted`, `error`
  - Classification: Insert-only append log.

## Known Gaps & Deferred Work
The following items were identified during Phase 1 but explicitly deferred:
- **Missing Parsers:** `MessageMapping`, `ScriptCollection`, `ServiceInterface`, `MessageType`, `FaultMessageType`, `DataType` have no explicit metadata parsers yet. They were deferred because the current tenant holds no data for them to verify against.
- **Missing Adapters Endpoint:** `IntegrationAdapterDesigntimeArtifacts` was explicitly excluded as no GET/list endpoint exists in SAP's API.
- **Missing Deployment Info:** `BuildAndDeployStatus` was explicitly excluded as it lacks a list endpoint (requires GET by `TaskId`, which is unsuitable for read-only mass discovery).
- **Custom Tag Permissions:** `CustomTagConfigurations` returns `403 Forbidden` with the current service account. The code catches this gracefully. A tenant-side role grant is required to populate it.
- **ValueMapping Relationships:** ValueMapping relationships will show as `0` unless the ValueMapping is invoked *directly* from a standard IFlow step (rather than hardcoded inside a Groovy Script or internal MessageMapping). 

## How to Extend
This engine heavily utilizes a queue-mediated module pattern:
- **API Fetching:** Always use `queue/index.js` (which handles dynamic token rotation, exponential backoff, retry handling, and pagination implicitly).
- **Classification Patterns:** Packages and Artifacts rely on `Id + Version` composite matching for idempotency. Modifying this logic should be done via standard MERGE/UPSERT flows. 
- **Cascade Deletions:** Done efficiently via left-join "not in this sync run ID" flags, preserving historic artifacts.
- **Parser Versioning:** When you update `parser/iflowParser.js`, bump `PARSER_VERSION` at the top of the file. This natively instructs the engine to re-parse all artifacts on the next run without re-downloading anything.
