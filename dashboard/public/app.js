let currentArtifactId = null;
let allArtifacts = [];
let isSyncing = false;

async function fetchAPI(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'API Error');
  }
  return res.json();
}

async function loadOverview() {
  try {
    const data = await fetchAPI('/api/overview');
    document.getElementById('overview-metrics').innerHTML = `
      <div class="metric"><span class="metric-label">Cycle</span><span class="metric-value">${data.last_cycle_status}</span></div>
      <div class="metric"><span class="metric-label">Failures (Capped)</span><span class="metric-value">${data.failures_found} (${data.capped_failures})</span></div>
      <div class="metric"><span class="metric-label">Fixes Pending</span><span class="metric-value">${data.pending_fixes}</span></div>
      <div class="metric"><span class="metric-label">Active Flags</span><span class="metric-value">${data.active_flags}</span></div>
    `;
  } catch (err) {
    console.error(err);
  }
}

async function loadArtifacts() {
  try {
    allArtifacts = await fetchAPI('/api/artifacts');
    renderArtifacts(allArtifacts);
  } catch (err) {
    console.error(err);
  }
}

function renderArtifacts(artifacts, isSearch = false) {
  const list = document.getElementById('artifact-list');
  if (!artifacts.length) {
    list.innerHTML = '<div style="padding: 1rem; color: var(--text-muted)">No matching artifacts</div>';
    return;
  }
  
  const groups = {};
  for (const a of artifacts) {
    const pkg = a.package_id || 'Unknown Package';
    if (!groups[pkg]) groups[pkg] = [];
    groups[pkg].push(a);
  }
  
  let html = '';
  for (const pkg of Object.keys(groups).sort()) {
    html += `
      <div class="package-group ${isSearch ? '' : 'collapsed'}">
        <div class="package-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="chevron"><polyline points="6 9 12 15 18 9"></polyline></svg>
          <span class="pkg-name">${pkg}</span>
          <span class="badge">${groups[pkg].length}</span>
        </div>
        <ul class="package-items">
          ${groups[pkg].map(a => {
            const status = a.runtime_status || 'UNKNOWN';
            const statusColor = status === 'STARTED' ? '#10b981' : status === 'FAILED' || status === 'ERROR' ? '#ef4444' : '#94a3b8';
            return `
            <li class="artifact-item ${a.artifact_id === currentArtifactId ? 'active' : ''}" data-id="${a.artifact_id}" onclick="selectArtifact('${a.artifact_id}')">
              <div class="artifact-name">${a.artifact_id}</div>
              <div class="artifact-meta">
                <span>Risk: ${a.composite_risk || 'N/A'}</span>
                <span style="color: ${statusColor}; font-weight: 600;">${status}</span>
              </div>
            </li>`;
          }).join('')}
        </ul>
      </div>
    `;
  }
  list.innerHTML = html;
}

async function selectArtifact(id) {
  currentArtifactId = id;
  document.querySelectorAll('.artifact-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.querySelector(`.artifact-item[data-id="${id}"]`);
  if (activeEl) activeEl.classList.add('active');

  document.getElementById('welcome-state').classList.add('hidden');
  document.getElementById('detail-state').classList.remove('hidden');

  try {
    const data = await fetchAPI(`/api/artifacts/${id}`);
    
    document.getElementById('detail-title').textContent = data.artifact.source_id;
    const rStatus = data.artifact.runtime_status || 'UNKNOWN';
    const statusColor = rStatus === 'STARTED' ? '#10b981' : rStatus === 'FAILED' || rStatus === 'ERROR' ? '#ef4444' : '#94a3b8';
    document.getElementById('detail-badges').innerHTML = `
      <span>Risk: ${data.risk ? data.risk.composite_risk : 'N/A'}</span>
      <span style="color:${statusColor}; font-weight:600;">Status: ${rStatus}</span>
      <span id="live-saved-version" style="background-color: var(--primary); color: white;">Saved: Loading...</span>
      <span id="live-deployed-version" style="background-color: var(--primary); color: white;">Deployed: Loading...</span>
    `;

    // Fetch live versions asynchronously (non-blocking)
    fetchAPI(`/api/artifacts/${id}/live-versions`).then(live => {
      const savedEl = document.getElementById('live-saved-version');
      const depEl = document.getElementById('live-deployed-version');
      if (savedEl) savedEl.textContent = `Saved: ${live.savedVersion !== 'Unknown' ? 'v' + live.savedVersion : live.savedVersion}`;
      if (depEl) depEl.textContent = `Deployed: ${live.deployedVersion !== 'Not Deployed' ? 'v' + live.deployedVersion : live.deployedVersion}`;
    }).catch(() => {
      const savedEl = document.getElementById('live-saved-version');
      const depEl = document.getElementById('live-deployed-version');
      if (savedEl) savedEl.textContent = `Saved: N/A`;
      if (depEl) depEl.textContent = `Deployed: N/A`;
    });

    // === RESET ALL SECTIONS ON ARTIFACT SWITCH ===
    // Clear the pending fix section immediately to avoid showing stale data from previous artifact
    const pendingSection = document.getElementById('pending-fix-section');
    const diffContainer = document.getElementById('diff-container');
    pendingSection.style.display = 'none';
    diffContainer.innerHTML = '';

    // Explain section reset
    const explainBtn = document.getElementById('explain-btn');
    explainBtn.disabled = false;
    explainBtn.textContent = 'View Explanation';
    document.getElementById('explain-status').textContent = '';
    document.getElementById('explain-download-btn').style.display = 'none';
    const explainContent = document.getElementById('explain-content');
    explainContent.style.display = 'none';
    explainContent.textContent = '';

    // Generate Fix section reset
    const genBtn = document.getElementById('generate-fix-btn');
    genBtn.disabled = false;
    genBtn.textContent = 'Generate Fix';
    document.getElementById('generate-status').textContent = '';

    // Apply section logic
    const applyInput = document.getElementById('apply-confirm-input');
    const applyBtn = document.getElementById('apply-fix-btn');
    applyInput.value = '';
    applyBtn.disabled = true;
    applyBtn.textContent = 'Apply Fix';
    applyInput.oninput = () => applyBtn.disabled = (applyInput.value !== data.artifact.source_id);
    
    if (data.fixes && data.fixes.length > 0) {
      pendingSection.style.display = 'block';
      const fix = data.fixes[0];
      
      let diffHtml = '';
      
      let manualSteps = [];
      try {
        if (fix.manual_steps) manualSteps = JSON.parse(fix.manual_steps);
      } catch(e) {}
      
      if (fix.outcome === 'NEEDS_STRUCTURAL_REVIEW') {
        diffHtml = `<div style="background: #1e293b; border: 1px solid #f59e0b; border-radius: 8px; padding: 1rem;">`;
        diffHtml += `<strong style="color: #f59e0b;">⚠ Needs Structural Review</strong><br/><br/>`;
        if (fix.error_summary) {
          diffHtml += `<strong>What went wrong:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.error_summary}</p>`;
        }
        if (fix.fix_summary) {
          diffHtml += `<strong>What needs to happen:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.fix_summary}</p>`;
        } else if (fix.explanation) {
          diffHtml += `<strong>Explanation:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.explanation}</p>`;
        }
        if (manualSteps && manualSteps.length > 0) {
          diffHtml += `<strong>Manual Fix Steps:</strong><ol style="margin: 0.5rem 0 0 1.2rem; color: var(--text-muted);">`;
          manualSteps.forEach(step => { diffHtml += `<li style="margin-bottom: 0.4rem;">${step}</li>`; });
          diffHtml += `</ol>`;
        }
        diffHtml += `</div>`;
      } else {
        const typeStr = fix.fix_type === 'xml_value' ? 'XML Value Fix' : 'Code Fix';
        diffHtml = `<div style="background: #1e293b; border: 1px solid #10b981; border-radius: 8px; padding: 1rem;">`;
        diffHtml += `<strong style="color: #10b981;">✓ Pending ${typeStr}</strong><br/><br/>`;
        if (fix.error_summary) {
          diffHtml += `<strong>What went wrong:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.error_summary}</p>`;
        }
        if (fix.fix_summary) {
          diffHtml += `<strong>How it was fixed:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.fix_summary}</p>`;
        } else if (fix.explanation) {
          diffHtml += `<strong>Explanation:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${fix.explanation}</p>`;
        }
        if (manualSteps && manualSteps.length > 0) {
          diffHtml += `<strong>Additional manual steps:</strong><ol style="margin: 0.5rem 0 1rem 1.2rem; color: var(--text-muted);">`;
          manualSteps.forEach(step => { diffHtml += `<li style="margin-bottom: 0.4rem;">${step}</li>`; });
          diffHtml += `</ol>`;
        }
        
        if (fix.error_signature) {
          diffHtml += `<strong>Raw Error:</strong><br/><pre style="background: var(--bg); color: var(--danger); padding: 0.5rem; border-radius: 4px; font-size: 0.85rem; margin-top: 0.5rem; white-space: pre-wrap; word-wrap: break-word; border: 1px solid var(--danger);">${fix.error_signature.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
        }
        
        // Show code diff or attribute path at the bottom
        if (fix.fix_type === 'xml_value') {
          diffHtml += `<div style="background: var(--bg); padding: 0.5rem; border-radius: 4px; font-size: 0.85rem; margin-top: 1rem;">
                        <span style="color:var(--text-muted)">Element Path:</span> <code>${fix.element_path}</code><br/>
                        <span style="color:var(--text-muted)">Attribute:</span> <code>${fix.attribute_name}</code><br/>
                      </div>`;
        } else {
          diffHtml += `<div style="background: var(--bg); padding: 0.5rem; border-radius: 4px; font-size: 0.85rem; margin-top: 1rem;">
                         <span style="color:var(--text-muted)">Proposed Script snippet:</span><br/><pre style="white-space: pre-wrap; margin-top: 0.2rem;">${fix.proposed_content ? fix.proposed_content.substring(0, 300) + '...' : ''}</pre>
                       </div>`;
        }
        
        diffHtml += `</div>`;
      }
      diffContainer.innerHTML = diffHtml;
    } else {
      pendingSection.style.display = 'none';
    }

    // Rollback section
    const versionList = document.getElementById('version-list-container');
    const rollbackInput = document.getElementById('rollback-confirm-input');
    const rollbackBtn = document.getElementById('rollback-btn');
    rollbackInput.value = '';
    rollbackBtn.disabled = true;
    rollbackBtn.textContent = 'Rollback';

    try {
      const versions = await fetchAPI(`/api/artifacts/${id}/versions`);
      if (versions.length > 0) {
        let optionsHtml = '';
        for (let i = 0; i < versions.length; i++) {
          const v = versions[i];
          const displayVersion = v.cpi_version ? `v${v.cpi_version}` : `ID ${v.id}`;
          optionsHtml += `<option value="${v.id}" ${i === 0 ? 'selected' : ''}>${displayVersion} - ${v.date_str} ${v.is_current ? '(Current)' : ''}</option>`;
        }
        versionList.innerHTML = `<select id="rollback-version-input" style="padding:0.75rem; background:#1e293b; color:white; border:1px solid #3b82f6; border-radius:4px; width:100%; cursor:pointer; font-size:1rem; margin-bottom:1rem;">
          ${optionsHtml}
        </select>`;
      } else {
        versionList.innerHTML = `<div style="color:var(--warning)">No backup versions available.</div>`;
      }
    } catch (err) {
      console.error(err);
      versionList.innerHTML = `<input type="number" id="rollback-version-input" placeholder="Version ID" style="padding:0.5rem; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px;">`;
    }
    
    const checkRollbackFields = () => {
      const el = document.getElementById('rollback-version-input');
      const vId = el ? el.value : '';
      rollbackBtn.disabled = !(rollbackInput.value === data.artifact.name && vId);
    };
    rollbackInput.oninput = checkRollbackFields;
    const vInput = document.getElementById('rollback-version-input');
    if (vInput) {
      vInput.onchange = checkRollbackFields;
      vInput.oninput = checkRollbackFields;
    }

    // Deploy section
    const deployInput = document.getElementById('deploy-confirm-input');
    const deployBtn = document.getElementById('deploy-btn');
    const deployStatus = document.getElementById('deploy-status');
    deployInput.value = '';
    deployBtn.disabled = true;
    deployBtn.textContent = 'Deploy';
    if (deployStatus) deployStatus.textContent = '';
    deployInput.oninput = () => deployBtn.disabled = (deployInput.value !== data.artifact.source_id);

    // Undeploy section
    const undeployInput = document.getElementById('undeploy-confirm-input');
    const undeployBtn = document.getElementById('undeploy-btn');
    undeployInput.value = '';
    undeployBtn.disabled = true;
    undeployBtn.textContent = 'Undeploy';
    undeployInput.oninput = () => undeployBtn.disabled = (undeployInput.value !== data.artifact.source_id);

    // Flags section
    const flagsContainer = document.getElementById('flags-container');
    if (data.flags && data.flags.length > 0) {
      flagsContainer.innerHTML = data.flags.map(f => `
        <div class="flag-item">
          <div>
            <strong>${f.error_signature.substring(0,50)}...</strong><br>
            <span style="font-size:0.75rem; color:var(--text-muted)">Recurrence: ${f.recurrence_count} | Snoozed: ${f.snoozed_until || 'No'}</span>
          </div>
          <button class="btn small" onclick="snoozeFlag(${f.id})">Snooze 30d</button>
        </div>
      `).join('');
    } else {
      flagsContainer.innerHTML = '<span style="color:var(--text-muted)">No active structural flags.</span>';
    }

  } catch (err) {
    console.error(err);
    alert('Failed to load artifact details');
  }
}

// Actions
document.getElementById('explain-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('explain-btn');
  const status = document.getElementById('explain-status');
  const contentBlock = document.getElementById('explain-content');
  const downloadBtn = document.getElementById('explain-download-btn');
  
  btn.disabled = true;
  btn.textContent = 'Explaining...';
  status.textContent = '';
  contentBlock.style.display = 'none';
  downloadBtn.style.display = 'none';

  try {
    const res = await fetchAPI(`/api/artifacts/${currentArtifactId}/explain`, { method: 'POST' });
    status.textContent = 'Explanation generated successfully!';
    status.style.color = 'var(--success)';
    
    // Show on screen
    contentBlock.textContent = res.explanation;
    contentBlock.style.display = 'block';
    
    // Show download button and attach data
    downloadBtn.style.display = 'inline-block';
    window.currentExplanationText = res.explanation;
    
    setTimeout(() => {
      status.textContent = ''; // clear status text after 3 seconds
    }, 3000);
    
  } catch (err) {
    status.textContent = err.message;
    status.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Regenerate Explanation';
  }
};

document.getElementById('explain-download-btn').onclick = () => {
  if (!window.currentExplanationText) return;
  const blob = new Blob([window.currentExplanationText], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentArtifactId}_explanation.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

document.getElementById('generate-fix-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('generate-fix-btn');
  const status = document.getElementById('generate-status');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  status.textContent = '';

  try {
    const res = await fetchAPI(`/api/artifacts/${currentArtifactId}/generate-fix`, { method: 'POST' });
    
    if (res.canAutoFix === false) {
      // Could not auto-fix — show manual steps
      status.style.color = 'var(--warning)';
      status.textContent = '⚠ Auto-fix not possible. Manual steps required.';
      
      let manualHtml = `<div style="background: #1e293b; border: 1px solid #f59e0b; border-radius: 8px; padding: 1rem; margin-top: 1rem;">`;
      manualHtml += `<strong style="color: #f59e0b;">⚠ Cannot Auto-Apply Fix</strong><br/><br/>`;
      if (res.errorSummary) {
        manualHtml += `<strong>What went wrong:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${res.errorSummary}</p>`;
      }
      if (res.fixSummary) {
        manualHtml += `<strong>What needs to happen:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${res.fixSummary}</p>`;
      }
      if (res.manualSteps && res.manualSteps.length > 0) {
        manualHtml += `<strong>Manual Fix Steps:</strong><ol style="margin: 0.5rem 0 0 1.2rem; color: var(--text-muted);">`;
        res.manualSteps.forEach(step => { manualHtml += `<li style="margin-bottom: 0.4rem;">${step}</li>`; });
        manualHtml += `</ol>`;
      }
      manualHtml += `</div>`;
      
      const diffContainer = document.getElementById('diff-container');
      const pendingSection = document.getElementById('pending-fix-section');
      pendingSection.style.display = 'block';
      diffContainer.innerHTML = manualHtml;
    } else {
      // Auto-fix was applied
      let successMsg = '✓ Fix generated!';
      if (res.confidenceLevel) successMsg += ` (Confidence: ${res.confidenceLevel})`;
      status.textContent = successMsg;
      status.style.color = 'var(--success)';
      
      // Show a preview immediately before reload
      const diffContainer = document.getElementById('diff-container');
      const pendingSection = document.getElementById('pending-fix-section');
      pendingSection.style.display = 'block';
      let previewHtml = `<div style="background: #1e293b; border: 1px solid #10b981; border-radius: 8px; padding: 1rem; margin-top: 1rem;">`;
      previewHtml += `<strong style="color: #10b981;">✓ Fix Generated (${res.fixType || 'code'})</strong><br/><br/>`;
      if (res.errorSummary) {
        previewHtml += `<strong>What went wrong:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 1rem 0;">${res.errorSummary}</p>`;
      }
      if (res.fixSummary) {
        previewHtml += `<strong>How it was fixed:</strong><br/><p style="color: var(--text-muted); margin: 0.5rem 0 0 0;">${res.fixSummary}</p>`;
      }
      if (res.manualSteps && res.manualSteps.length > 0) {
        previewHtml += `<br/><strong>Additional manual steps:</strong><ol style="margin: 0.5rem 0 0 1.2rem; color: var(--text-muted);">`;
        res.manualSteps.forEach(step => { previewHtml += `<li style="margin-bottom: 0.4rem;">${step}</li>`; });
        previewHtml += `</ol>`;
      }
      previewHtml += `</div>`;
      diffContainer.innerHTML = previewHtml;
      
      setTimeout(() => selectArtifact(currentArtifactId), 2000);
    }
  } catch (err) {
    status.textContent = err.message;
    status.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Fix';
  }
};

document.getElementById('apply-fix-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('apply-fix-btn');
  const input = document.getElementById('apply-confirm-input');
  btn.disabled = true;
  btn.textContent = 'Applying...';
  
  try {
    await fetchAPI(`/api/fixes/${currentArtifactId}/apply`, {
      method: 'POST',
      body: JSON.stringify({ confirmedArtifactName: input.value })
    });
    alert('Fix applied successfully!');
    selectArtifact(currentArtifactId);
  } catch (err) {
    alert(`Apply failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Apply Fix';
  }
};

document.getElementById('rollback-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('rollback-btn');
  const input = document.getElementById('rollback-confirm-input');
  const vId = document.getElementById('rollback-version-input').value;
  btn.disabled = true;
  btn.textContent = 'Rolling back...';
  
  try {
    await fetchAPI(`/api/artifacts/${currentArtifactId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ confirmedArtifactName: input.value, targetVersionId: vId })
    });
    alert('Rollback successful!');
    selectArtifact(currentArtifactId);
  } catch (err) {
    alert(`Rollback failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Rollback';
  }
};

document.getElementById('undeploy-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('undeploy-btn');
  const input = document.getElementById('undeploy-confirm-input');
  btn.disabled = true;
  btn.textContent = 'Undeploying...';
  
  try {
    await fetchAPI(`/api/artifacts/${currentArtifactId}/undeploy`, {
      method: 'POST',
      body: JSON.stringify({ confirmedArtifactName: input.value })
    });
    alert('Undeploy successful!');
    selectArtifact(currentArtifactId);
  } catch (err) {
    alert(`Undeploy failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Undeploy';
  }
};

document.getElementById('deploy-btn').onclick = async () => {
  if (!currentArtifactId) return;
  const btn = document.getElementById('deploy-btn');
  const input = document.getElementById('deploy-confirm-input');
  const statusEl = document.getElementById('deploy-status');
  btn.disabled = true;
  btn.textContent = 'Deploying...';
  if (statusEl) statusEl.textContent = '';
  
  try {
    await fetchAPI(`/api/artifacts/${currentArtifactId}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ confirmedArtifactName: input.value })
    });
    if (statusEl) { statusEl.textContent = '✓ Deploy triggered! Status may take a moment to update.'; statusEl.style.color = 'var(--success)'; }
    setTimeout(() => selectArtifact(currentArtifactId), 3000);
  } catch (err) {
    alert(`Deploy failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Deploy';
  }
};

window.snoozeFlag = async (id) => {
  try {
    await fetchAPI(`/api/structural-flags/${id}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify({ days: 30 })
    });
    if (currentArtifactId) selectArtifact(currentArtifactId);
  } catch (err) {
    alert(`Snooze failed: ${err.message}`);
  }
}

async function syncTenant() {
  if (isSyncing) return;
  
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = '↻ Syncing...';
  isSyncing = true;
  
  try {
    const res = await fetchAPI('/api/sync', { method: 'POST' });
    if (res.error) throw new Error(res.error);
    
    // Reload everything
    await loadOverview();
    await loadArtifacts();
    
    // If we have an active artifact selected, reload its details
    if (currentArtifactId) {
      await selectArtifact(currentArtifactId);
    }
    
    // Show temporary success state
    btn.textContent = '✓ Synced';
    btn.classList.add('success');
    setTimeout(() => {
      btn.textContent = '↻ Refresh';
      btn.classList.remove('success');
      btn.disabled = false;
      isSyncing = false;
    }, 2000);
    
  } catch (err) {
    console.error('Sync failed:', err);
    alert('Failed to sync tenant data: ' + err.message);
    btn.textContent = '↻ Refresh';
    btn.disabled = false;
    isSyncing = false;
  }
}

// Init
document.getElementById('artifact-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  const filtered = allArtifacts.filter(a => 
    a.name.toLowerCase().includes(q) || 
    (a.package_id && a.package_id.toLowerCase().includes(q))
  );
  renderArtifacts(filtered, q.length > 0);
});

loadOverview();
loadArtifacts();
setInterval(loadOverview, 10000);
