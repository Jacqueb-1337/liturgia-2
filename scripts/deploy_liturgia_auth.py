#!/usr/bin/env python3
"""
Simple FTP deploy script to upload the `liturgia/auth` files and `liturgia/license-status.php` to the remote web host using credentials from `.vscode/sftp.json`.
This script uploads only the files in the `liturgia/auth/` folder and `liturgia/license-status.php`.
"""
import json, os, ftplib, sys
cfg_path = os.path.join(os.path.dirname(__file__), '..', '.vscode', 'sftp.json')
if not os.path.exists(cfg_path):
    print('sftp.json not found at', cfg_path); sys.exit(1)
cfg = json.load(open(cfg_path))
host = cfg.get('host')
port = cfg.get('port', 21)
user = cfg.get('username')
passwd = cfg.get('password')
remote_base = cfg.get('remotePath', '/httpdocs/')
# we want to upload into remote_base + 'liturgia'
remote_dir = os.path.join(remote_base, 'liturgia').replace('\\','/')
files = [
    'liturgia/auth/db.php',
    'liturgia/auth/generate-token.php',
    'liturgia/auth/list-tokens.php',
    'liturgia/auth/show-token.php',
    'liturgia/auth/revoke-token.php',
    'liturgia/auth/account-summary.php',
    'liturgia/auth/magic-link.php',
    'liturgia/license-status.php',
    'liturgia/test_helpers.php',
    'liturgia/diag_env.php',
    'liturgia/lint_license.php'
]
try:
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=10)
    ftp.login(user, passwd)
    # Ensure remote directory exists or try to create
    try:
        ftp.cwd(remote_dir)
    except Exception:
        # create path recursively
        parts = remote_dir.strip('/').split('/')
        p = ''
        for part in parts:
            p += '/' + part
            try:
                ftp.mkd(p)
            except Exception:
                pass
        ftp.cwd(remote_dir)
    for f in files:
        local = os.path.join(os.getcwd(), f).replace('\\','/')
        remote_path = f.replace('liturgia/', '') if f.startswith('liturgia/') else os.path.basename(f)
        if not os.path.exists(local):
            print('SKIP (missing):', local); continue
        with open(local, 'rb') as fh:
            dest = os.path.join(remote_dir, remote_path).replace('\\','/')
            # ensure remote subdirs exist
            rdir = os.path.dirname(dest)
            try:
                ftp.cwd(rdir)
            except Exception:
                # create chain
                parts = rdir.replace(remote_dir, '').strip('/').split('/')
                cur = remote_dir
                for part in parts:
                    if not part: continue
                    cur = cur + '/' + part
                    try:
                        ftp.mkd(cur)
                    except Exception:
                        pass
                ftp.cwd(rdir)
            print('Uploading', local, '->', dest)
            ftp.storbinary('STOR ' + os.path.basename(dest), fh)
    ftp.quit()
    print('Upload complete')
except Exception as e:
    print('FTP error:', e)
    sys.exit(2)
