<?php
header('Content-Type: application/json');

$logFile = '/boot/config/plugins/openclaw-connect/activity.jsonl';

if (file_exists($logFile)) {
    file_put_contents($logFile, '');
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => true, 'message' => 'Log file does not exist']);
}
