<?php
/* Service control - supports GET and POST */
header('Content-Type: application/json');

$action = $_GET['action'] ?? $_POST['action'] ?? '';
$allowed = ['start', 'stop', 'restart'];

if (!in_array($action, $allowed, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid action: ' . $action]);
    exit;
}

$output = [];
$returnCode = 0;
exec("/etc/rc.d/rc.unraidclaw {$action} 2>&1", $output, $returnCode);

echo json_encode([
    'action' => $action,
    'returnCode' => $returnCode,
    'output' => implode("\n", $output),
]);
