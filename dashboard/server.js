const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const db = require('../database');
const { generateFixForArtifact } = require('../fixer/generate');
const { applyFixForArtifact } = require('../fixer/apply');
const { rollbackArtifact } = require('../deploy/rollback');
const { undeployArtifactAction } = require('../deploy/undeploy');
const { deployArtifact } = require('../deploy/index');
const { generateExplanation, fetchFromLLMWithRetry } = require('../reviewer/llm');
const { assembleContext } = require('../reviewer/context');
const { NeedsStructuralReviewError, GenerationFailedError } = require('../orchestrator/errors');
const { getFailureDetails } = require('../logs/index');
const queue = require('../queue');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === READ ENDPOINTS ===

app.get('/api/overview', (req, res) => {
  try {
    const cycle = db.prepare('SELECT * FROM healing_cycles ORDER BY started_at DESC LIMIT 1').get() || {};
    const pendingFixes = db.prepare('SELECT COUNT(*) as count FROM generated_fixes WHERE applied = 0').get().count;
    const activeFlags = db.prepare(`SELECT COUNT(*) as count FROM structural_flags WHERE resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)`).get().count;
    
    res.json({
      last_cycle_status: cycle.completed_at ? 'completed' : 'running',
      failures_found: cycle.failures_found || 0,
      capped_failures: cycle.capped_failures || 0,
      fixes_generated: cycle.fixes_generated || 0,
      pending_fixes: pendingFixes,
      active_flags: activeFlags
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/artifacts', (req, res) => {
  try {
    const artifacts = db.prepare(`
      SELECT a.source_id as artifact_id, a.name, a.package_id, rs.status as runtime_status, rs.deployed_on, risk.composite_risk
      FROM artifacts a
      LEFT JOIN runtime_status rs ON a.source_id = rs.artifact_id
      LEFT JOIN (
        SELECT artifact_id, composite_risk, MAX(computed_at)
        FROM risk_scores GROUP BY artifact_id
      ) risk ON a.source_id = risk.artifact_id
      WHERE a.deleted_at IS NULL
    `).all();
    res.json(artifacts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/artifacts/:id', (req, res) => {
  try {
    const artifactId = req.params.id;
    const artifact = db.prepare(`
      SELECT a.*, rs.status as runtime_status, rs.deployed_on
      FROM artifacts a
      LEFT JOIN runtime_status rs ON a.source_id = rs.artifact_id
      WHERE a.source_id = ? AND a.deleted_at IS NULL
    `).get(artifactId);
    
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    
    const risk = db.prepare('SELECT * FROM risk_scores WHERE artifact_id = ? ORDER BY computed_at DESC LIMIT 1').get(artifactId);
    const flags = db.prepare('SELECT * FROM structural_flags WHERE artifact_id = ? AND resolved_at IS NULL').all(artifactId);
    const fixes = db.prepare('SELECT * FROM generated_fixes WHERE artifact_id = ? AND applied = 0 ORDER BY generated_at DESC').all(artifactId);
    const deployments = db.prepare('SELECT * FROM deployments WHERE artifact_id = ? ORDER BY initiated_at DESC LIMIT 10').all(artifactId);
    
    res.json({ artifact, risk, flags, fixes, deployments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/api/artifacts/:id/versions', (req, res) => {
  try {
    const artifactId = req.params.id;
    const allVersions = db.prepare(`
      SELECT id, cpi_version, content_hash, metadata_hash, inner_content_hash, saved_at
      FROM artifact_versions 
      WHERE artifact_id = ? 
      ORDER BY saved_at DESC LIMIT 50
    `).all(artifactId);

    if (allVersions.length === 0) {
      return res.json([]);
    }

    const distinctVersions = [];
    let currentGroup = null;

    for (const v of allVersions) {
      if (!currentGroup) {
        currentGroup = { ...v, oldest_saved_at: v.saved_at };
        distinctVersions.push(currentGroup);
      } else {
        if (v.inner_content_hash && v.inner_content_hash === currentGroup.inner_content_hash) {
          currentGroup.oldest_saved_at = v.saved_at; 
        } else {
          currentGroup = { ...v, oldest_saved_at: v.saved_at };
          distinctVersions.push(currentGroup);
        }
      }
    }

    const displayVersions = distinctVersions.slice(0, 10).map(v => {
      let dateStr = v.saved_at;
      if (v.oldest_saved_at !== v.saved_at) {
        dateStr = `unchanged from ${v.oldest_saved_at} to ${v.saved_at}`;
      }
      const isCurrent = v.inner_content_hash ? (v.inner_content_hash === allVersions[0].inner_content_hash) : (v.content_hash === allVersions[0].content_hash);
      return {
        id: v.id,
        cpi_version: v.cpi_version,
        saved_at: v.saved_at,
        date_str: dateStr,
        is_current: isCurrent,
        hash: v.inner_content_hash ? v.inner_content_hash.substring(0,8) : v.content_hash.substring(0,8)
      };
    });

    res.json(displayVersions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/artifacts/:id/live-versions', async (req, res) => {
  const artifactId = req.params.id;
  try {
    const artifactRow = db.prepare('SELECT package_id FROM artifacts WHERE source_id = ?').get(artifactId);
    let savedVersion = 'Unknown';
    let deployedVersion = 'Not Deployed';

    if (artifactRow && artifactRow.package_id) {
      try {
        const savedRes = await queue.get(`/IntegrationPackages('${artifactRow.package_id}')/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`);
        if (savedRes && savedRes.data && savedRes.data.d) {
          savedVersion = savedRes.data.d.Version || 'Unknown';
        }
      } catch(e) {
        console.warn(`[API] Failed to fetch saved version for ${artifactId}: ${e.message}`);
      }
    }

    try {
      const depRes = await queue.get(`/IntegrationRuntimeArtifacts('${artifactId}')`);
      const d = depRes && depRes.data && depRes.data.d;
      if (d) {
        // Some tenants wrap in results[], others return directly
        const entry = Array.isArray(d.results) ? d.results[0] : d;
        if (entry && entry.Version) deployedVersion = entry.Version;
      }
    } catch(e) {
      if (e.response && e.response.status === 404) {
        deployedVersion = 'Not Deployed';
      } else {
        console.warn(`[API] Failed to fetch deployed version for ${artifactId}: ${e.message}`);
      }
    }

    res.json({ savedVersion, deployedVersion });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fixes/pending', (req, res) => {
  try {
    const fixes = db.prepare(`
      SELECT * FROM generated_fixes 
      WHERE applied = 0 
      ORDER BY generated_at DESC
    `).all();
    res.json(fixes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/structural-flags', (req, res) => {
  try {
    const flags = db.prepare(`
      SELECT * FROM structural_flags 
      WHERE resolved_at IS NULL 
      ORDER BY last_flagged_at DESC
    `).all();
    res.json(flags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', (req, res) => {
  exec('node discovery/run.js', { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      console.error('Sync error:', stderr);
      return res.status(500).json({ error: error.message, details: stderr });
    }
    res.json({ success: true, message: 'Sync complete' });
  });
});

// === WRITE ENDPOINTS ===

app.post('/api/artifacts/:id/generate-fix', async (req, res) => {
  const artifactId = req.params.id;
  try {
    const result = await generateFixForArtifact(artifactId);
    res.json(result);
  } catch (err) {
    // If it needs structural review or can't auto-fix, ask LLM for manual steps
    if (err instanceof NeedsStructuralReviewError || err instanceof GenerationFailedError) {
      try {
        const failureDetails = await getFailureDetails(artifactId, { hours: 720, details: true, bypassCache: true });
        const errorText = (failureDetails && failureDetails.length > 0) ? failureDetails[0].error : err.message;
        const manualPrompt = `You are an SAP CPI expert. A customer's integration flow called "${artifactId}" is failing in production and we cannot automatically apply a code fix. Please provide clear, actionable manual fix steps.

Error:
${errorText}

Reason we cannot auto-fix: ${err.message}

Respond with ONLY a JSON object in this exact schema, no markdown:
{
  "errorSummary": "Plain-English 1-2 sentence explanation of what went wrong.",
  "fixSummary": "Plain-English summary of what needs to be done to resolve this.",
  "manualSteps": ["Step 1...", "Step 2...", "Step 3..."]
}`;
        const raw = await fetchFromLLMWithRetry([{ role: 'user', content: manualPrompt }], 2, 4);
        const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        return res.json({
          success: false,
          canAutoFix: false,
          errorSummary: parsed.errorSummary,
          fixSummary: parsed.fixSummary,
          manualSteps: parsed.manualSteps || []
        });
      } catch (llmErr) {
        return res.json({
          success: false,
          canAutoFix: false,
          errorSummary: err.message,
          fixSummary: 'Manual review required.',
          manualSteps: ['Review the error in SAP CPI Monitoring', 'Check adapter configuration', 'Verify credentials and endpoint URLs']
        });
      }
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/artifacts/:id/explain', async (req, res) => {
  const artifactId = req.params.id;
  try {
    const contextResult = await assembleContext(artifactId, { requireStarted: false });
    if (!contextResult) {
      return res.status(404).json({ error: 'Could not assemble context for artifact.' });
    }
    const explanation = await generateExplanation(contextResult.contextBundleString, artifactId);
    res.json({ explanation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fixes/:id/apply', async (req, res) => {
  const artifactId = req.params.id;
  const { confirmedArtifactName } = req.body;
  if (!confirmedArtifactName || confirmedArtifactName !== artifactId) {
    return res.status(400).json({ error: "Confirmation artifact name did not match." });
  }
  
  try {
    const result = await applyFixForArtifact(artifactId, confirmedArtifactName, 'dashboard');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/artifacts/:id/rollback', async (req, res) => {
  const artifactId = req.params.id;
  const { confirmedArtifactName, targetVersionId } = req.body;
  if (!confirmedArtifactName || confirmedArtifactName !== artifactId) {
    return res.status(400).json({ error: "Confirmation artifact name did not match." });
  }
  if (!targetVersionId) {
    return res.status(400).json({ error: "Target version ID is required." });
  }

  try {
    const result = await rollbackArtifact(artifactId, confirmedArtifactName, targetVersionId, 'dashboard');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/artifacts/:id/undeploy', async (req, res) => {
  const artifactId = req.params.id;
  const { confirmedArtifactName } = req.body;
  if (!confirmedArtifactName || confirmedArtifactName !== artifactId) {
    return res.status(400).json({ error: "Confirmation artifact name did not match." });
  }

  try {
    const result = await undeployArtifactAction(artifactId, confirmedArtifactName, false, 'dashboard');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/artifacts/:id/deploy', async (req, res) => {
  const artifactId = req.params.id;
  const { confirmedArtifactName } = req.body;
  if (!confirmedArtifactName || confirmedArtifactName !== artifactId) {
    return res.status(400).json({ error: 'Confirmation artifact name did not match.' });
  }

  try {
    const result = await deployArtifact(artifactId, 'dashboard');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/structural-flags/:id/acknowledge', (req, res) => {
  const flagId = req.params.id;
  const { days = 30 } = req.body;
  try {
    db.prepare(`
      UPDATE structural_flags 
      SET snoozed_until = datetime(CURRENT_TIMESTAMP, '+' || ? || ' days'),
          acknowledged_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(days, flagId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Dashboard running safely on http://127.0.0.1:${PORT}`);
});
