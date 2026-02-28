/* OpenClaw Connect - WebGUI JavaScript */

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

// ── Service control ──
function occServiceControl(action) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/plugins/openclaw-connect/php/service-control.php', true);
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      location.reload();
    }
  };
  xhr.send('action=' + encodeURIComponent(action));
}

// ── API key generation ──
function occGenerateKey() {
  if (!confirm('Generate a new API key? The old key will be invalidated.')) return;
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/plugins/openclaw-connect/php/generate-key.php', true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      var display = document.getElementById('occ-key-display');
      var keyInput = document.getElementById('occ-new-key');
      if (xhr.status === 200) {
        try {
          var resp = JSON.parse(xhr.responseText);
          if (resp.key) {
            display.style.display = 'block';
            keyInput.value = resp.key;
            keyInput.style.color = '#51cf66';
          } else if (resp.error) {
            display.style.display = 'block';
            keyInput.value = 'Error: ' + resp.error;
            keyInput.style.color = '#ff6b6b';
          }
        } catch(e) {
          display.style.display = 'block';
          keyInput.value = 'Error parsing response: ' + xhr.responseText.substring(0, 200);
          keyInput.style.color = '#ff6b6b';
        }
      } else {
        display.style.display = 'block';
        keyInput.value = 'HTTP Error ' + xhr.status + ': ' + xhr.responseText.substring(0, 200);
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
  xhr.open('POST', '/plugins/openclaw-connect/php/save-permissions.php', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4) {
      var status = document.getElementById('occ-perm-status');
      if (xhr.status === 200) {
        status.textContent = 'Saved!';
        status.style.color = '#155724';
      } else {
        status.textContent = 'Error saving permissions';
        status.style.color = '#721c24';
      }
      setTimeout(function() { status.textContent = ''; }, 3000);
    }
  };
  xhr.send(JSON.stringify(permissions));
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
  xhr.open('POST', '/plugins/openclaw-connect/php/clear-log.php', true);
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
