<?php
header('Content-Type: application/json');

$logFile = '/boot/config/plugins/unraidclaw/activity.jsonl';
$limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 100;
$limit = max(1, min(1000, $limit));

if (!file_exists($logFile)) {
    echo '[]';
    exit;
}

// Read last N lines efficiently
$lines = [];
$fp = fopen($logFile, 'r');
if ($fp) {
    while (($line = fgets($fp)) !== false) {
        $line = trim($line);
        if (!empty($line)) {
            $lines[] = $line;
            if (count($lines) > $limit) {
                array_shift($lines);
            }
        }
    }
    fclose($fp);
}

$entries = [];
foreach ($lines as $line) {
    $entry = json_decode($line, true);
    if ($entry) {
        $entries[] = $entry;
    }
}

echo json_encode($entries);
