<?php
header('Content-Type: application/json');

$permFile = '/boot/config/plugins/openclaw-connect/permissions.json';
$input = json_decode(file_get_contents('php://input'), true);

if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid input']);
    exit;
}

// Sanitize: only boolean values
$clean = [];
foreach ($input as $key => $value) {
    if (preg_match('/^[a-z_]+:[a-z]+$/', $key)) {
        $clean[$key] = (bool)$value;
    }
}

$dir = dirname($permFile);
if (!is_dir($dir)) {
    mkdir($dir, 0755, true);
}

if (file_put_contents($permFile, json_encode($clean, JSON_PRETTY_PRINT)) !== false) {
    echo json_encode(['success' => true, 'count' => count(array_filter($clean))]);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'Failed to write permissions file']);
}
