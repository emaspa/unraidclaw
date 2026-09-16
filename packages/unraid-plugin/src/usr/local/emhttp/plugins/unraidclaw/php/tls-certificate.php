<?php
// Read public certificate metadata only. The private key is never opened.
function occReadTlsCertificate($certFile) {
    if (!file_exists($certFile)) {
        return ['present' => false];
    }

    $output = [];
    $code = 0;
    exec('openssl x509 -in ' . escapeshellarg($certFile) .
        ' -noout -subject -nameopt RFC2253 -enddate -fingerprint -sha256 -ext subjectAltName 2>/dev/null', $output, $code);
    $certificate = ['present' => true, 'subject' => '', 'subjectAltName' => [], 'expiry' => '', 'fingerprint' => ''];
    $readingSan = false;
    foreach ($output as $line) {
        $line = trim($line);
        if (strpos($line, 'subject=') === 0) {
            $certificate['subject'] = trim(substr($line, 8));
        } elseif (strpos($line, 'notAfter=') === 0) {
            $certificate['expiry'] = trim(substr($line, 9));
        } elseif (stripos($line, 'sha256 Fingerprint=') === 0) {
            $certificate['fingerprint'] = trim(substr($line, strpos($line, '=') + 1));
            $readingSan = false;
        } elseif (strpos($line, 'X509v3 Subject Alternative Name:') === 0) {
            $readingSan = true;
        } elseif ($readingSan && $line !== '') {
            $certificate['subjectAltName'] = array_merge(
                $certificate['subjectAltName'], array_map('trim', explode(',', $line))
            );
        }
    }
    if ($code !== 0 || $certificate['subject'] === '' || $certificate['expiry'] === '' || $certificate['fingerprint'] === '') {
        return ['present' => true, 'error' => 'Unable to read the TLS certificate with OpenSSL.'];
    }
    return $certificate;
}
