<?php
/* Regenerate the TLS certificate through GET for emhttp AJAX requests. */
header('Content-Type: application/json');
header('Cache-Control: no-store');
require_once __DIR__ . '/tls-certificate.php';

function occCertificateError($message, $extra = [], $status = 500) {
    http_response_code($status);
    echo json_encode(array_merge(['success' => false, 'error' => $message], $extra));
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET' || ($_GET['action'] ?? '') !== 'regenerate') {
    occCertificateError('Use GET with action=regenerate.', [], 400);
}

$service = '/etc/rc.d/rc.unraidclaw';
$tlsDir = '/boot/config/plugins/unraidclaw/tls';
if (!is_file($service) || !is_executable($service)) {
    occCertificateError('The UnraidClaw service command is missing or not executable.');
}
if (!is_dir($tlsDir)) {
    occCertificateError('The TLS directory is missing. Start the service to create it first.');
}

// Serialize button requests, including requests from another browser tab.
$lock = @fopen($tlsDir . '/.regenerate.lock', 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    occCertificateError('Certificate regeneration is already running or the TLS directory is not writable.');
}

$names = [];
foreach (['cert.pem', 'key.pem'] as $name) {
    $path = $tlsDir . '/' . $name;
    if (is_link($path) || (file_exists($path) && !is_file($path))) {
        occCertificateError('Cannot move ' . $name . ': expected a regular file.');
    }
    if (!file_exists($path)) continue;
    if (is_link($path . '.bak') || (file_exists($path . '.bak') && !is_file($path . '.bak'))) {
        occCertificateError('Cannot move ' . $name . ': its backup path is not a regular file.');
    }
    $names[] = $name;
}

// Keep older backups too. Both files use the same first unused suffix.
$suffix = 1;
while (file_exists($tlsDir . '/cert.pem.bak.' . $suffix) || is_link($tlsDir . '/cert.pem.bak.' . $suffix) ||
       file_exists($tlsDir . '/key.pem.bak.' . $suffix) || is_link($tlsDir . '/key.pem.bak.' . $suffix)) {
    $suffix++;
}
$moves = [];
foreach ($names as $name) {
    $path = $tlsDir . '/' . $name;
    if (file_exists($path . '.bak')) $moves[] = [$path . '.bak', $path . '.bak.' . $suffix];
}
foreach ($names as $name) {
    $path = $tlsDir . '/' . $name;
    $moves[] = [$path, $path . '.bak'];
}
$moved = [];
foreach ($moves as $move) {
    if (!@rename($move[0], $move[1])) {
        $restored = true;
        foreach (array_reverse($moved) as $previous) {
            // A failed restore must not let an older backup overwrite it.
            if (file_exists($previous[0]) || is_link($previous[0]) ||
                !@rename($previous[1], $previous[0])) $restored = false;
        }
        occCertificateError($restored
            ? 'Could not move the TLS files. The original files are unchanged; the service was not restarted.'
            : 'Could not move or restore all TLS files. The service was not restarted. Recover the files from the TLS directory before retrying.');
    }
    $moved[] = $move;
}

$output = [];
$serviceCode = 0;
exec(escapeshellarg($service) . ' restart 2>&1', $output, $serviceCode);
// Do not pass PEM private key blocks through even if a service prints one.
$serviceOutput = preg_replace('/-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)/s',
    '[private key redacted]', implode("\n", $output));
clearstatcache();
$certificate = occReadTlsCertificate($tlsDir . '/cert.pem');
$result = ['certificate' => $certificate, 'serviceOutput' => $serviceOutput, 'serviceCode' => $serviceCode];
if ($serviceCode !== 0) {
    occCertificateError('The service restart failed. Previous TLS files are kept as .bak files.', $result);
}
if (!$certificate['present'] || isset($certificate['error']) || !is_file($tlsDir . '/key.pem') || filesize($tlsDir . '/key.pem') === 0) {
    occCertificateError('The service did not create a readable certificate and key. Previous TLS files are kept as .bak files.', $result);
}
echo json_encode(array_merge(['success' => true], $result));
