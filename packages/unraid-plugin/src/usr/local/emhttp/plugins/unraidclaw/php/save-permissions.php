<?php
/* Save permissions - supports GET and POST */
header('Content-Type: application/json');

$permFile = '/boot/config/plugins/unraidclaw/permissions.json';

// Accept JSON from query param (GET) or body (POST)
$raw = $_GET['data'] ?? null;
if ($raw === null) {
    $raw = file_get_contents('php://input');
}

$input = json_decode($raw, true);

if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid input', 'raw_length' => strlen($raw ?? '')]);
    exit;
}

// Sanitize: only boolean values with valid key format
$clean = [];
foreach ($input as $key => $value) {
    if (preg_match('/^[a-z_]+:[a-z]+$/', $key)) {
        $clean[$key] = (bool)$value;
    }
}

$dir = dirname($permFile);
if (!is_dir($dir)) {
    @mkdir($dir, 0755, true);
}

$result = @file_put_contents($permFile, json_encode($clean, JSON_PRETTY_PRINT));
if ($result !== false) {
    echo json_encode(['success' => true, 'count' => count(array_filter($clean)), 'total' => count($clean)]);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to write: ' . $permFile]);
}
