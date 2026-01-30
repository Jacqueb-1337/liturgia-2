#!/usr/bin/env python3
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
remote_dir = os.path.join(remote_base, 'liturgia').replace('\\','/')
local = os.path.join(os.getcwd(), 'liturgia', 'test_helpers.php')
if not os.path.exists(local):
    print('local test file missing'); sys.exit(1)
try:
    ftp = ftplib.FTP()
    ftp.connect(host, port, timeout=10)
    ftp.login(user, passwd)
    ftp.cwd(remote_dir)
    with open(local, 'rb') as fh:
        ftp.storbinary('STOR ' + os.path.basename(local), fh)
    ftp.quit()
    print('Uploaded test_helpers.php')
except Exception as e:
    print('FTP error:', e)
    sys.exit(2)
