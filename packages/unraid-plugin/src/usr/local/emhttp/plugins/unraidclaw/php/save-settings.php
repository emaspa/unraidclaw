<?php
/* Save settings - supports GET (AJAX) and POST (form) */
$plugin = 'unraidclaw';
$cfgFile = "/boot/config/plugins/{$plugin}/unraidclaw.cfg";

$fields = ['SERVICE', 'PORT', 'HOST', 'GRAPHQL_URL', 'UNRAID_API_KEY', 'MAX_LOG_SIZE'];

// Accept from GET query params or POST body
$input = !empty($_GET) ? $_GET : $_POST;

// Check if AJAX request (wants JSON response)
$isAjax = isset($input['ajax']);

if ($isAjax) {
    header('Content-Type: application/json');
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

// Manage service
$serviceOutput = '';
$serviceCode = 0;
if (($cfg['SERVICE'] ?? 'disable') === 'enable') {
    exec("/etc/rc.d/rc.{$plugin} restart 2>&1", $out, $serviceCode);
    $serviceOutput = implode("\n", $out);
} else {
    exec("/etc/rc.d/rc.{$plugin} stop 2>&1", $out, $serviceCode);
    $serviceOutput = implode("\n", $out);
}

if ($isAjax) {
    echo json_encode([
        'success' => $writeResult !== false,
        'service' => ($cfg['SERVICE'] ?? 'disable') === 'enable' ? 'restarted' : 'stopped',
        'serviceOutput' => $serviceOutput,
        'serviceCode' => $serviceCode,
    ]);
} else {
    header("Location: /Settings/{$plugin}.settings");
}
