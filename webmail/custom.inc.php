<?php
// Extra Roundcube settings (mounted into /var/roundcube/config/).

// Authenticate to the submission port with the same credentials as the IMAP login.
$config['smtp_user'] = '%u';
$config['smtp_pass'] = '%p';

// Verify the mail server's certificate; the name matches because the container resolves
// MX_HOST (see extra_hosts in compose.webmail.yaml).
$config['imap_conn_options'] = ['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]];
$config['smtp_conn_options'] = ['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]];

$config['product_name'] = 'Mail';
$config['enable_installer'] = false;
