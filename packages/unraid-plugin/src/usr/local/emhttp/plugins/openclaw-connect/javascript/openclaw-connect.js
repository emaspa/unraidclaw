/* OpenClaw Connect - WebGUI JavaScript v2 */

// ── Permission presets (mirror of shared/permissions.ts) ──
var OCC_PRESETS = {
  'read-only': [
    'docker:read','vms:read','array:read','disk:read','share:read',
    'info:read','config:read','services:read','notification:read',
    'network:read','me:read','api_key:read','logs:read','flash:read','vars:read'
  ],
  'docker-manager': [
    'docker:read','docker:create','docker:update','docker:delete',
    'info:read','logs:read'
  ],
  'vm-manager': [
    'vms:read','vms:create','vms:update','vms:delete',
    'info:read','logs:read'
  ],
  'full-admin': null, // all checked
  'none': []          // all unchecked
};

// ── Category to checkbox name mapping ──
var OCC_CATEGORIES = {
  'docker':       ['docker:read','docker:update','docker:create','docker:delete'],
  'vms':          ['vms:read','vms:update','vms:create','vms:delete'],
  'storage':      ['array:read','array:update','disk:read','disk:update','share:read','share:create','share:update','share:delete'],
  'system':       ['info:read','config:read','config:update','os:update','services:read','services:update'],
  'notification': ['notification:read','notification:create','notification:update','notification:delete'],
  'network':      ['network:read','network:update'],
  'users':        ['me:read','api_key:read','api_key:create','api_key:update','api_key:delete'],
  'logs':         ['logs:read','flash:read','vars:read']
};

// ── CSRF token (set from .page files) ──
var OCC_CSRF = '';

// ── Service control ──
function occServiceControl(action) {
  var btn = event ? event.target : null;
  if (btn) { btn.disabled = true; btn.textContent = action + 'ing...'; }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/plugins/openclaw-connect/php/service-control.php?action=' + encodeURIComponent(action), true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      if (xhr.status === 200 && xhr.responseText) {
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp.returnCode !== 0) {
            alert('Service ' + action + ' failed (code ' + resp.returnCode + '):\n' + resp.output);
          }
        } catch(e) {}
      } else if (xhr.responseText === '') {
        alert('Empty response from service control - PHP may not be executing');
      }
      location.reload();
    }
  };
  xhr.send();
}

// ── API key generation ──
function occGenerateKey() {
  if (!confirm('Generate a new API key? The old key will be invalidated.')) return;

  var display = document.getElementById('occ-key-display');
  var keyInput = document.getElementById('occ-new-key');
  display.style.display = 'block';
  keyInput.value = 'Generating...';
  keyInput.style.color = '#aaa';

  var xhr = new XMLHttpRequest();
  // Use GET to avoid CSRF issues with emhttp
  xhr.open('GET', '/plugins/openclaw-connect/php/generate-key.php?action=generate&csrf_token=' + encodeURIComponent(OCC_CSRF), true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      var raw = xhr.responseText || '';
      var debugInfo = '[HTTP ' + xhr.status + ', len=' + raw.length + ']';

      if (raw.length === 0) {
        keyInput.value = 'Empty response ' + debugInfo + ' - PHP may not be executing. Check Unraid syslog.';
        keyInput.style.color = '#ff6b6b';
        return;
      }

      try {
        var resp = JSON.parse(raw);
        if (resp.key) {
          keyInput.value = resp.key;
          keyInput.style.color = '#51cf66';
        } else if (resp.error) {
          keyInput.value = 'Error: ' + resp.error;
          keyInput.style.color = '#ff6b6b';
        } else {
          keyInput.value = 'Unexpected: ' + raw.substring(0, 300);
          keyInput.style.color = '#ff6b6b';
        }
      } catch(e) {
        keyInput.value = 'Not JSON ' + debugInfo + ': ' + raw.substring(0, 300);
        keyInput.style.color = '#ff6b6b';
      }
    }
  };
  xhr.send();
}

function occCopyKey() {
  var input = document.getElementById('occ-new-key');
  input.select();
  document.execCommand('copy');
}

// ── Permissions ──
function occApplyPreset(name) {
  var preset = OCC_PRESETS[name];
  var checkboxes = document.querySelectorAll('#occ-permissions-form input[type="checkbox"]');
  for (var i = 0; i < checkboxes.length; i++) {
    if (preset === null) {
      checkboxes[i].checked = true;  // full-admin
    } else {
      checkboxes[i].checked = preset.indexOf(checkboxes[i].name) !== -1;
    }
  }
  occUpdatePermissionSummaries();
}

function occSetCategory(cat, value) {
  var keys = OCC_CATEGORIES[cat];
  if (!keys) return;
  for (var i = 0; i < keys.length; i++) {
    var cb = document.querySelector('input[name="' + keys[i] + '"]');
    if (cb) cb.checked = value;
  }
  occUpdatePermissionSummaries();
}

function occToggleCategory(header) {
  header.classList.toggle('expanded');
  var body = header.nextElementSibling;
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
}

function occUpdatePermissionSummaries() {
  for (var cat in OCC_CATEGORIES) {
    var keys = OCC_CATEGORIES[cat];
    var enabled = 0;
    for (var i = 0; i < keys.length; i++) {
      var cb = document.querySelector('input[name="' + keys[i] + '"]');
      if (cb && cb.checked) enabled++;
    }
    var summaryEl = document.querySelector('[data-category="' + cat + '"]');
    if (summaryEl) {
      summaryEl.textContent = enabled + '/' + keys.length;
    }
  }
}

function occSavePermissions() {
  var permissions = {};
  var checkboxes = document.querySelectorAll('#occ-permissions-form input[type="checkbox"]');
  for (var i = 0; i < checkboxes.length; i++) {
    permissions[checkboxes[i].name] = checkboxes[i].checked;
  }

  var xhr = new XMLHttpRequest();
  var data = encodeURIComponent(JSON.stringify(permissions));
  xhr.open('GET', '/plugins/openclaw-connect/php/save-permissions.php?data=' + data, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      var status = document.getElementById('occ-perm-status');
      if (xhr.status === 200) {
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp.success) {
            status.textContent = 'Saved! (' + resp.count + ' permissions enabled)';
            status.style.color = '#51cf66';
          } else {
            status.textContent = 'Error: ' + (resp.error || 'Unknown');
            status.style.color = '#ff6b6b';
          }
        } catch(e) {
          status.textContent = 'Error: ' + xhr.responseText.substring(0, 100);
          status.style.color = '#ff6b6b';
        }
      } else {
        status.textContent = 'Error saving (HTTP ' + xhr.status + ')';
        status.style.color = '#ff6b6b';
      }
      setTimeout(function() { status.textContent = ''; }, 5000);
    }
  };
  xhr.send();
}

// ── Activity log ──
function occRefreshLog() {
  var limit = document.getElementById('occ-log-limit');
  var maxLines = limit ? parseInt(limit.value) : 100;

  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/plugins/openclaw-connect/php/read-log.php?limit=' + maxLines, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4 && xhr.status === 200) {
      var entries = JSON.parse(xhr.responseText);
      var tbody = document.getElementById('occ-log-body');
      if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="7"><em>No log entries</em></td></tr>';
        return;
      }
      var html = '';
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        var statusClass = '';
        if (e.statusCode >= 200 && e.statusCode < 300) statusClass = 'occ-status-2xx';
        else if (e.statusCode >= 400 && e.statusCode < 500) statusClass = 'occ-status-4xx';
        else if (e.statusCode >= 500) statusClass = 'occ-status-5xx';

        html += '<tr class="occ-log-row">' +
          '<td>' + escapeHtml(e.timestamp) + '</td>' +
          '<td>' + escapeHtml(e.method) + '</td>' +
          '<td>' + escapeHtml(e.path) + '</td>' +
          '<td>' + escapeHtml(e.resource) + '</td>' +
          '<td class="' + statusClass + '">' + e.statusCode + '</td>' +
          '<td>' + e.durationMs + 'ms</td>' +
          '<td>' + escapeHtml(e.ip) + '</td>' +
          '</tr>';
      }
      tbody.innerHTML = html;
    }
  };
  xhr.send();
}

function occClearLog() {
  if (!confirm('Clear the activity log?')) return;
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/plugins/openclaw-connect/php/clear-log.php', true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      occRefreshLog();
    }
  };
  xhr.send();
}

function occFilterLog() {
  var filter = document.getElementById('occ-log-filter').value.toLowerCase();
  var rows = document.querySelectorAll('.occ-log-row');
  for (var i = 0; i < rows.length; i++) {
    var text = rows[i].textContent.toLowerCase();
    rows[i].style.display = text.indexOf(filter) !== -1 ? '' : 'none';
  }
}

function occLoadRecentActivity() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/plugins/openclaw-connect/php/read-log.php?limit=10', true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4 && xhr.status === 200) {
      var entries = JSON.parse(xhr.responseText);
      var container = document.getElementById('occ-recent-activity');
      if (!container) return;
      if (!entries.length) {
        container.innerHTML = '<em>No recent activity</em>';
        return;
      }
      var html = '<table style="width:100%; font-size:12px;"><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th></tr>';
      for (var i = entries.length - 1; i >= 0; i--) {
        var e = entries[i];
        html += '<tr><td>' + escapeHtml(e.timestamp) + '</td><td>' + escapeHtml(e.method) + '</td><td>' + escapeHtml(e.path) + '</td><td>' + e.statusCode + '</td></tr>';
      }
      html += '</table>';
      container.innerHTML = html;
    }
  };
  xhr.send();
}

function occSaveSettings(e) {
  e.preventDefault();
  var form = document.getElementById('occ-settings-form');
  var btn = document.getElementById('occ-apply-btn');
  var status = document.getElementById('occ-settings-status');

  btn.disabled = true;
  btn.textContent = 'Saving...';
  status.textContent = '';

  // Collect form fields as query params
  var params = ['ajax=1'];
  var inputs = form.querySelectorAll('input[name], select[name]');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    if (inp.name && inp.name !== 'csrf_token') {
      params.push(encodeURIComponent(inp.name) + '=' + encodeURIComponent(inp.value));
    }
  }

  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/plugins/openclaw-connect/php/save-settings.php?' + params.join('&'), true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      btn.disabled = false;
      btn.textContent = 'Apply';
      if (xhr.status === 200 && xhr.responseText) {
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp.success) {
            status.textContent = 'Settings saved! Service ' + resp.service + '.';
            status.style.color = '#51cf66';
          } else {
            status.textContent = 'Error saving settings';
            status.style.color = '#ff6b6b';
          }
        } catch(ex) {
          status.textContent = 'Error: ' + xhr.responseText.substring(0, 100);
          status.style.color = '#ff6b6b';
        }
      } else {
        status.textContent = 'Error (HTTP ' + xhr.status + ')';
        status.style.color = '#ff6b6b';
      }
      setTimeout(function() { status.textContent = ''; }, 5000);
    }
  };
  xhr.send();
  return false;
}

function occResetDefaults() {
  if (!confirm('Reset all settings to defaults?')) return;
  var form = document.getElementById('occ-settings-form');
  if (form) form.reset();
}

// ── Utility ──
function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}
