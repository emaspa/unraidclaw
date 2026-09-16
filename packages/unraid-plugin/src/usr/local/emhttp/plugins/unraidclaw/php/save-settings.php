<?php
/* Save settings - supports GET (AJAX) and POST (form) */
$plugin = 'unraidclaw';
$cfgFile = "/boot/config/plugins/{$plugin}/unraidclaw.cfg";

$fields = ['SERVICE', 'MCP_ENABLED', 'PORT', 'HOST', 'GRAPHQL_URL', 'UNRAID_API_KEY', 'MAX_LOG_SIZE'];

// Accept from GET query params or POST body
$input = !empty($_GET) ? $_GET : $_POST;

// Check if AJAX request (wants JSON response)
$isAjax = isset($input['ajax']);

if ($isAjax) {
    header('Content-Type: application/json');
}

// Reject malformed values before writing config or managing the service.
if (array_key_exists('MCP_ENABLED', $input) && !in_array($input['MCP_ENABLED'], ['yes', 'no'], true)) {
    http_response_code(400);
    echo $isAjax
        ? json_encode(['success' => false, 'error' => 'MCP_ENABLED must be yes or no'])
        : 'MCP_ENABLED must be yes or no';
    exit;
}

// Read current config (to preserve API_KEY_HASH and other keys)
$cfg = [];
if (file_exists($cfgFile)) {
    $lines = @file($cfgFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines) {
        foreach ($lines as $line) {
            $line = trim($line);
            if (empty($line) || $line[0] === '#') continue;
            $parts = explode('=', $line, 2);
            if (count($parts) === 2) {
                $key = trim($parts[0]);
                $val = trim($parts[1], " \t\n\r\0\x0B\"'");
                $cfg[$key] = $val;
            }
        }
    }
}

// Update from input
foreach ($fields as $field) {
    if (isset($input[$field])) {
        // Don't overwrite API key with empty value (preserves existing key)
        if ($field === 'UNRAID_API_KEY' && $input[$field] === '') continue;
        $cfg[$field] = $input[$field];
    }
}

// Validate port
if (isset($cfg['PORT'])) {
    $port = (int)$cfg['PORT'];
    if ($port < 1024 || $port > 65535) {
        $cfg['PORT'] = '9876';
    }
}

// Build GraphQL URL from Unraid WebUI port
if (isset($input['UNRAID_WEBUI_PORT'])) {
    $webPort = (int)$input['UNRAID_WEBUI_PORT'];
    if ($webPort > 0 && $webPort <= 65535) {
        $cfg['GRAPHQL_URL'] = $webPort === 80
            ? 'http://localhost/graphql'
            : "http://localhost:{$webPort}/graphql";
    }
}

// Write config
$dir = dirname($cfgFile);
if (!is_dir($dir)) {
    @mkdir($dir, 0755, true);
}

$content = '';
foreach ($cfg as $key => $value) {
    $content .= "{$key}=\"{$value}\"\n";
}

$writeResult = @file_put_contents($cfgFile, $content);
if ($writeResult !== false) @chmod($cfgFile, 0600);
$enabled = ($cfg['SERVICE'] ?? 'disable') === 'enable';

// Manage the service only after the config is saved, and check that it really
// ended up running or stopped instead of trusting the rc script's exit code.
// The rc script backgrounds node, so a gateway that dies on startup (a port
// already in use, for example) still returns 0 from restart.
$serviceOutput = '';
$serviceCode = 0;
$serviceState = '';
if ($writeResult !== false) {
    $out = [];
    exec("/etc/rc.d/rc.{$plugin} " . ($enabled ? 'restart' : 'stop') . " 2>&1", $out, $serviceCode);
    $serviceOutput = implode("\n", $out);
    if ($serviceCode === 0) {
        if ($enabled) usleep(1500000);
        $status = [];
        exec("/etc/rc.d/rc.{$plugin} status 2>&1", $status);
        $serviceState = trim(implode("\n", $status));
    }
}
$serviceOk = $serviceCode === 0 && $serviceState === ($enabled ? 'running' : 'stopped');

if ($isAjax) {
    $response = [
        'success' => $writeResult !== false && $serviceOk,
        'saved' => $writeResult !== false,
        'service' => $enabled ? 'restarted' : 'stopped',
        'serviceState' => $serviceState,
        'serviceOutput' => $serviceOutput,
        'serviceCode' => $serviceCode,
    ];
    if ($writeResult === false) {
        $response['error'] = 'Could not write the settings file; the service was not changed';
    } elseif (!$serviceOk) {
        $response['error'] = $enabled
            ? 'Settings saved, but the service is not running. Check /var/log/unraidclaw.log'
            : 'Settings saved, but the service did not stop';
    }
    echo json_encode($response);
} else {
    header("Location: /Settings/{$plugin}.settings");
}
