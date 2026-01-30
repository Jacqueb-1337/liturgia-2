#!/usr/bin/env python3
import os, json, ftplib, sys
cfg_path = os.path.join(os.path.dirname(__file__), '..', '.vscode', 'sftp.json')
if not os.path.exists(cfg_path):
    print('sftp.json not found at', cfg_path); sys.exit(1)
cfg = json.load(open(cfg_path))
host = cfg.get('host')
port = cfg.get('port', 21)
user = cfg.get('username')
passwd = cfg.get('password')
remote_base = cfg.get('remotePath', '/httpdocs/')
remote_dir = os.path.join(remote_base, 'liturgia').replace('\\','/')
files = [
    'auth/generate-token.php',
    'auth/list-tokens.php',
    'auth/show-token.php',
    'auth/revoke-token.php',
    'auth/account-summary.php',
    'auth/magic-link.php',
    'license-status.php'
]
local_dir = os.path.join(os.getcwd(), 'tmp_remote_backup')
if not os.path.exists(local_dir): os.makedirs(local_dir)
try:
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=10)
    ftp.login(user, passwd)
    ftp.cwd(remote_dir)
    for f in files:
        remote_path = os.path.join(remote_dir, f).replace('\\','/')
        local_path = os.path.join(local_dir, os.path.basename(f))
        try:
            with open(local_path, 'wb') as fh:
                print('Downloading', remote_path, '->', local_path)
                ftp.retrbinary('RETR ' + os.path.basename(remote_path), fh.write)
        except Exception as e:
            print('SKIP/ERR', f, e)
    ftp.quit()
    print('Downloaded files to', local_dir)
except Exception as e:
    print('FTP error:', e)
    sys.exit(2)
