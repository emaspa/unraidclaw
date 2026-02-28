<?php
$action = $_POST['action'] ?? '';
$allowed = ['start', 'stop', 'restart'];

if (!in_array($action, $allowed, true)) {
    http_response_code(400);
    echo 'Invalid action';
    exit;
}

$output = [];
$returnCode = 0;
exec("/etc/rc.d/rc.openclaw-connect {$action} 2>&1", $output, $returnCode);

header('Content-Type: application/json');
echo json_encode([
    'action' => $action,
    'returnCode' => $returnCode,
    'output' => implode("\n", $output),
]);
