<?php
$plugin = 'openclaw-connect';
$cfgFile = "/boot/config/plugins/{$plugin}/openclaw-connect.cfg";

$fields = ['SERVICE', 'PORT', 'HOST', 'GRAPHQL_URL', 'UNRAID_API_KEY', 'MAX_LOG_SIZE'];

// Read current config (to preserve API_KEY_HASH)
$cfg = [];
if (file_exists($cfgFile)) {
    $lines = file($cfgFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
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

// Update from POST
foreach ($fields as $field) {
    if (isset($_POST[$field])) {
        $cfg[$field] = $_POST[$field];
    }
}

// Validate port
if (isset($cfg['PORT'])) {
    $port = (int)$cfg['PORT'];
    if ($port < 1024 || $port > 65535) {
        $cfg['PORT'] = '9876';
    }
}

// Write
$dir = dirname($cfgFile);
if (!is_dir($dir)) {
    mkdir($dir, 0755, true);
}

$content = '';
foreach ($cfg as $key => $value) {
    $content .= "{$key}=\"{$value}\"\n";
}

file_put_contents($cfgFile, $content);

// Restart service if enabled
if (($cfg['SERVICE'] ?? 'disable') === 'enable') {
    exec("/etc/rc.d/rc.{$plugin} restart 2>&1");
} else {
    exec("/etc/rc.d/rc.{$plugin} stop 2>&1");
}

// Redirect back to settings
header("Location: /Settings/{$plugin}.settings");
