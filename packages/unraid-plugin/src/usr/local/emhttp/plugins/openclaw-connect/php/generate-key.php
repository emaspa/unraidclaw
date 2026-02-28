<?php
header('Content-Type: application/json');

$cfgFile = '/boot/config/plugins/openclaw-connect/openclaw-connect.cfg';

// Generate a 32-byte random key
$rawKey = bin2hex(random_bytes(32));
$hash = hash('sha256', $rawKey);

// Read current config
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

// Update hash
$cfg['API_KEY_HASH'] = $hash;

// Write back
$content = '';
foreach ($cfg as $key => $value) {
    $content .= "{$key}=\"{$value}\"\n";
}

$dir = dirname($cfgFile);
if (!is_dir($dir)) {
    mkdir($dir, 0755, true);
}

if (file_put_contents($cfgFile, $content) !== false) {
    echo json_encode(['key' => $rawKey, 'hash_prefix' => substr($hash, 0, 16)]);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to save API key']);
}
