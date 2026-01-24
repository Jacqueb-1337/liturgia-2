import sqlite3, json, sys
email = sys.argv[1] if len(sys.argv) > 1 else None
if not email:
    print('Usage: inspect_user.py <email>')
    sys.exit(1)
try:
    db = sqlite3.connect('liturgia/data/licenses.sqlite')
    cur = db.execute('SELECT * FROM users WHERE email=? LIMIT 1', (email,))
    row = cur.fetchone()
    if not row:
        print('null')
    else:
        cols = [d[0] for d in cur.description]
        print(json.dumps(dict(zip(cols, row))))
except Exception as e:
    print('ERROR', str(e))