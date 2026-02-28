<?php
/* Clear activity log - supports GET and POST */
header('Content-Type: application/json');

$logFile = '/boot/config/plugins/unraidclaw/activity.jsonl';

if (file_exists($logFile)) {
    file_put_contents($logFile, '');
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => true, 'message' => 'Log file does not exist']);
}
