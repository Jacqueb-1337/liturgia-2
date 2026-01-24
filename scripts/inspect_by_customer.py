import sqlite3, json, sys
cust = sys.argv[1] if len(sys.argv) > 1 else None
if not cust:
    print('Usage: inspect_by_customer.py <stripe_customer_id>')
    sys.exit(1)
try:
    db = sqlite3.connect('liturgia/data/licenses.sqlite')
    cur = db.execute('SELECT * FROM users WHERE stripe_customer_id=? LIMIT 1', (cust,))
    row = cur.fetchone()
    if not row:
        print('null')
    else:
        cols = [d[0] for d in cur.description]
        print(json.dumps(dict(zip(cols, row))))
except Exception as e:
    print('ERROR', str(e))