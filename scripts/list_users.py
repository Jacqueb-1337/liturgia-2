import sqlite3, json
try:
    db=sqlite3.connect('liturgia/data/licenses.sqlite')
    cur=db.execute('SELECT id,email,active,plan,created_at,expires_at FROM users ORDER BY created_at DESC LIMIT 20')
    rows=cur.fetchall()
    cols=[d[0] for d in cur.description]
    for r in rows:
        print(json.dumps(dict(zip(cols,r))))
except Exception as e:
    print('ERROR', e)