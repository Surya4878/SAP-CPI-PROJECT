# SAP CPI Metadata Discovery Engine

## Overview
This engine is a read-only metadata ingestion and relationship-mapping layer for SAP Cloud Platform Integration (CPI). It recursively crawls the SAP CPI OData API to discover, download, and catalog integration packages, runtime artifacts, configurations, and mapping schemas into a highly structured local SQLite database. It extracts the raw BPMN XML from discovered artifacts, builds a relationship graph of cross-artifact dependencies and external endpoints, and maintains an idempotent, incremental state snapshot of the entire tenant.

## Setup
### Prerequisites
- Node.js (v18+)
- SQLite3

### Environment Variables
You must configure the `.env` file at the root of the project. See `.env.example` for the required keys.
```ini
API_HOST=https://your-tenant.it-cpi...
TOKEN_URL=https://your-tenant.authentication...
CLIENT_ID=sb-your-client-id
CLIENT_SECRET=your-client-secret
RATE_LIMIT=5
LLM_API_KEY=your_nvidia_or_openrouter_api_key # Required for Reviewer (Phase 2, Unit 4)
LLM_API_URL=https://integrate.api.nvidia.com/v1/chat/completions # Nvidia NIM endpoint
MODEL_NAME=meta/llama-3.1-70b-instruct # Defaults to NVIDIA-hosted Llama 3.1 70B
REVIEW_WINDOW_HOURS=720 # Context window for fetching recent errors (defaults to 30 days)
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
- `sync_runs`: Represents a historical audit log of every sync execution and its metrics.
  - Columns: `id`, `started_at`, `completed_at`, `mode`, `packages_new`, `packages_changed`, `packages_deleted`, `artifacts_new`, `artifacts_changed`, `artifacts_deleted`, `error`
  - Classification: Insert-only append log.

## Phase 2: Impact Analysis & Graph Traversal Engine
Built on top of the `relationships` table, this engine provides deep graph traversal capabilities to determine the precise blast radius of any component change, safely handling recursive dependencies and cyclic call chains (e.g. self-referencing ProcessDirect or JMS queues).

### Core Engine (`impact/index.js`)
Exposes four primary operations:
- **`getDownstreamImpact(artifactId)`**: Ascertains what breaks if a given iFlow changes (finds all direct and transitive callers).
- **`getUpstreamDependencies(artifactId)`**: Ascertains what a given iFlow depends upon (finds external systems and downstream iFlows it triggers).
- **`getExternalSystemImpact(systemHost)`**: Identifies all iFlows connecting to a given external system endpoint (answers "what breaks if this external system goes down?").
- **`getBlastRadius(artifactId)`**: A consolidated summary object synthesizing the above, computing counts and extracting raw risk factor signals (like the presence of custom Exception Subprocesses) directly from `parsed_metadata`.

### CLI Tool (`impact/query.js`)
An interactive CLI designed to execute impact queries seamlessly. 

**Usage:**
```bash
# Get full blast radius for an iFlow
node impact/query.js Assignment_ProcessDirect_and_JMS_Integration_2nd_iflow

# Check which iFlows interact with external systems
node impact/query.js Decoder
node impact/query.js --system smtp.gmail.com
```

### 4. Targeted Error & Log Retrieval (Phase 2, Unit 3)
A localized module (`logs/index.js`) for on-demand inspection of an iFlow's recent runtime health. This component deliberately avoids unbounded bulk extraction of MessageProcessingLogs; instead, it uses a bounded short-TTL cache (5 minutes) in a `log_queries` table to safely expose aggregate run statistics and error messages for individual iFlows without overwhelming the tenant. This forms the runtime sensor for the impact analysis engine, allowing it to report if a high-blast-radius iFlow is currently failing.

```bash
node logs/query.js Decoder --details --hours 24
```

### 5. Reviewer Agent (Phase 2, Unit 4)
An LLM-in-the-loop component (`reviewer/query.js`) that analyzes existing *deployed* iFlows for structural and operational risks. 
It combines `parsed_metadata` (adapters, exception handling) and runtime `logs` into a compact JSON context bundle and runs it against a capable OpenAI-compatible endpoint (defaulting to the **NVIDIA NIM API** with `meta/llama-3.1-70b-instruct`). It is strictly read-only, does not send your raw source code (Groovy/XSLT) to the LLM, and enforces structured JSON responses for predictable issue tracking.

**Security & Privacy:**
Using NVIDIA NIM (`build.nvidia.com`) means your API requests are sent directly to NVIDIA's enterprise endpoints. Your raw OData package structure, endpoints, and error stack traces are transmitted. While NVIDIA NIM ensures enterprise-grade security and does not train on your inputs, ensure you treat `LLM_API_KEY` securely. 

**Cost & Quotas:**
NVIDIA NIM provides generous free credits for developers, but it is **not entirely free** once those promotional credits are exhausted. 
*Fallback Note:* If NVIDIA free credits run out, you can safely revert `LLM_API_URL` to OpenRouter and `MODEL_NAME` to `deepseek/deepseek-chat:free` (or similar) in your `.env` to maintain a zero-cost capability.
Reviews are cached locally in the `reviews` table based on a cryptographic hash of the JSON context bundle. This ensures that the LLM is only called if the structure, impact radius, or recent error logs of an iFlow change, making repeated checks completely free.

```bash
# Run a single review
node reviewer/query.js Decoder

# Run review over all deployed artifacts, sorted by risk
node reviewer/reviewAll.js
```

### 6. Risk Assessment Layer (Phase 2, Unit 5)
A deterministic scoring module (`risk/index.js` and `risk/report.js`) that synthesizes the read-only intelligence gathered by previous units into a single, actionable dashboard.

It computes a composite risk score (`OK`, `LOW`, `MEDIUM`, `NOT_REVIEWED`, `HIGH`) by looking at three vectors:
- **Structural Risk**: Blast radius, external system dependencies, transitive depth (from Unit 2).
- **Runtime Risk**: Recent failure rate percentage (from Unit 3).
- **Reviewer Risk**: The severity of findings and verdict from the LLM (from Unit 4).

The ranking logic ensures that a `HIGH` finding from the Reviewer explicitly elevates the composite score, while an unassessed iFlow explicitly flags as `NOT_REVIEWED` to prioritize it on the dashboard without silently blending in with safe artifacts.

**Usage:**
```bash
# Generate a dashboard of composite risk scores for all active artifacts
node risk/report.js
```

## Setup & Running

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

### 7. Automated Self-Healing (Phase 3 & Phase 4)
This engine goes beyond read-only metadata scanning to enable closed-loop, automated, LLM-driven remediation of failing integration flows. It safely limits its scope strictly to Groovy scripts, avoiding potentially catastrophic changes to XML structural routing or adapter properties.

- **Phase 3**: Introduced the capability to download active content, safely inject modifications (write access), and redeploy artifacts securely using CSRF-protected API pathways.
- **Phase 4, Unit 1 (Fix Generator)**: A single-artifact CLI (`fixer/generate.js`) that detects active failures, queries an LLM to generate a Groovy script patch based on the exact error stack trace, and enforces a mandatory human-in-the-loop review (`fixer/review.js`) before applying (`fixer/apply.js`).
- **Phase 4, Unit 2 (Healing Orchestrator)**: An orchestration layer (`orchestrator/run.js`) that automates detection, deduplication, fix generation, and outcome verification across the entire tenant. It acts as an unattended background cycle that primes the queue of pending fixes for human review.
- **Phase 4, Unit 3 (Unattended Mode)**: Adds `--unattended` mode with cost caps, staleness TTL with smart discrimination, structural flag escalation with snooze/acknowledge, and machine-readable exit codes for OS scheduler integration — all without changing the human-gated apply boundary.

**Orchestrator Details:**
- **No Unattended Applies:** The Orchestrator strictly stops at generation. It will never auto-apply a fix. Applying is still 100% human-gated.
- **Structural Flags:** If an error stems from something other than a Groovy script (e.g., a BPMN Content Modifier issue), the system intentionally aborts generation and flags the artifact as requiring `NEEDS_STRUCTURAL_REVIEW`, respecting its scope boundaries.
- **Outcome Tracking:** It continuously tracks previously-applied fixes to verify if the error actually ceased in the live logs, dynamically updating its status to `RESOLVED` or `FIX_FAILED`.
- **Ghost Error Prevention:** Uses `sinceDeployment: true` in the log retrieval engine so the Orchestrator only ever reasons about failures occurring *after* an artifact's most recent deployment.

```bash
# Run a manual healing cycle
node orchestrator/run.js

# Run a manual cycle and also write reports/latest.md
node orchestrator/run.js --report

# Run an unattended cycle (enforces cap, writes report, exits 1 on red)
node orchestrator/run.js --unattended

# View the pending fix queue and structural flags
node orchestrator/run.js --pending

# Snooze a structural flag for 30 days (stops it triggering red exit)
node orchestrator/run.js --acknowledge-flag <artifactId> --days 30

# Review a generated fix (diff view)
node fixer/review.js <artifactId>

# Apply a generated fix
node fixer/apply.js <artifactId>
```

### Unattended Mode (Phase 4, Unit 3)

**Environment Variables:**
```ini
MAX_FIXES_PER_CYCLE=2   # Max LLM calls per --unattended cycle (default: 2)
STALE_FIX_DAYS=7        # Days before unapplied fix or structural flag escalates (default: 7)
```

**Report Files:**
- `reports/latest.md` — overwritten each cycle. Leads with a verdict line (🟢/🟡/🔴) for instant readability.
- `reports/history.log` — one line per cycle appended forever. Trend visibility without storing full historical reports.

**Exit Code Convention:**
- `0` — 🟢 (clean) or 🟡 (needs attention but not urgent). Safe to run again next cycle.
- `1` — 🔴 (action required): cycle errors, stale fixes still actively failing, or structural flags past the `STALE_FIX_DAYS` TTL without an active snooze.

**Structural Flag Escalation & Snooze:**
Structural flags are tracked in a `structural_flags` table with their full history (`first_flagged_at`, `recurrence_count`). After `STALE_FIX_DAYS` without resolution they escalate to 🔴. Use `--acknowledge-flag` to snooze them:
- Snooze sets `snoozed_until` and `acknowledged_at` — `first_flagged_at` is never modified (audit record).
- Snoozed flags still appear in `reports/latest.md` as 🟡 (labeled "snoozed until DATE").
- If a snoozed flag goes quiet (resolves naturally) and then recurs, the snooze is cleared automatically — a recurrence after resolution is new information that warrants re-evaluation.

**Hooking into Windows Task Scheduler:**

Create a scheduled task that runs daily at 02:00 and emails on failure using the exit code:
```powershell
# Register a daily Task Scheduler job (PowerShell, run as Administrator)
$action = New-ScheduledTaskAction -Execute "node" `
  -Argument "C:\path\to\project\orchestrator\run.js --unattended" `
  -WorkingDirectory "C:\path\to\project"
$trigger = New-ScheduledTaskTrigger -Daily -At 2:00AM
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "SAP-CPI-Healer" -Action $action -Trigger $trigger -Settings $settings

# To alert on failure: add a second action that runs only if exit code != 0
# (Task Scheduler UI: Actions tab → "Start a program" on failure event)
# or pipe output to a log file and use Windows Event Log triggers.
```

**Linux/macOS cron equivalent:**
```cron
# Run at 02:00 daily; email output if exit code != 0
# Run at 02:00 daily; email output if exit code != 0
0 2 * * * cd /path/to/project && node orchestrator/run.js --unattended >> /var/log/sap-cpi-healer.log 2>&1 || mail -s "SAP-CPI Healer: ACTION REQUIRED" you@example.com < reports/latest.md
```

### 8. Action-Capable Dashboard (Phase 5, Unit 1)
A web-based local dashboard providing a read-only overview of engine state and gated action execution.

**Security Constraints:**
- The API explicitly binds to `127.0.0.1` and will not accept traffic from external interfaces.
- **Typed Confirmation Gate:** Actionable buttons in the UI (Apply, Rollback, Undeploy) are completely disabled until the exact name of the artifact is typed.
- **Server-Side Verification:** The backend explicitly enforces the same check (`if (artifactId !== confirmedArtifactName) throw`). The UI cannot bypass this simply by tampering with client-side checks.

**Usage:**
```bash
# Start the local dashboard
npm run dashboard
```
Then navigate to `http://127.0.0.1:3000` to browse artifacts, view risk metrics, generate fixes, and safely apply changes.
