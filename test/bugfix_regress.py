#!/usr/bin/env python3
"""Targeted regression checks for the 2026-10-30 bug-fix marathon."""
import json, sys, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18096"
PASS, FAIL = [], []

def call(method, path, token=None, body=None, raw_body=None):
    req = urllib.request.Request(BASE + path, method=method)
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = None
    if raw_body is not None:
        data = raw_body.encode()
        req.add_header("Content-Type", "application/json")
    elif body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=15) as r:
            txt = r.read().decode()
            try:
                return r.status, json.loads(txt)
            except Exception:
                return r.status, txt
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt

def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (("  " + str(extra)) if not cond else ""))

def login(user, pin):
    st, d = call("POST", "/api/auth/login", body={"username": user, "pin": pin})
    return d.get("token", "") if st == 200 else ""

A = login("admin", "888888")
S = login("staff", "666666")
check("logins", bool(A) and bool(S))

# product: price RM100.00, cost RM60
st, p = call("POST", "/api/products", A, {"name": "REG-A", "price_cents": 10000, "cost_cents": 6000, "stock_qty": 50})
pid = p.get("id", 0)
check("product created", st == 200 and pid > 0, p)

# 1. sale idempotency on client_ref
sale_body = {"items": [{"product_id": pid, "qty": 1}], "method": "CASH",
             "tendered_cents": 10000, "client_ref": "ref-uuid-1"}
st1, s1 = call("POST", "/api/sales", A, sale_body)
st2, s2 = call("POST", "/api/sales", A, dict(sale_body))
check("idempotent retry returns same sale", st1 == 200 and st2 == 200
      and s1.get("id") == s2.get("id") and s2.get("duplicate") is True, (s1, s2))
st, lst = call("GET", "/api/sales?limit=500", A)
n_ref = sum(1 for x in lst.get("items", []) if x.get("client_ref") == "ref-uuid-1")
check("only one sale row for client_ref", n_ref == 1, n_ref)

# 2. duplicate bank_ref -> 409
b1 = {"items": [{"product_id": pid, "qty": 1}], "method": "DUITNOW",
      "tendered_cents": 10000, "bank_ref": "BANKREF123", "client_ref": "ref-uuid-2"}
b2 = dict(b1, client_ref="ref-uuid-3")
st1, r1 = call("POST", "/api/sales", A, b1)
st2, r2 = call("POST", "/api/sales", A, b2)
check("first bank_ref sale ok", st1 == 200, r1)
check("duplicate bank_ref 409", st2 == 409, (st2, r2))

# 3. payment claim first-wins
st, c1 = call("POST", "/api/payments/claim", A, {"ref_no": "CLAIMREF9"})
st, c2 = call("POST", "/api/payments/claim", S, {"ref_no": "CLAIMREF9"})
check("claim first device wins", c1.get("claimed") is True, c1)
check("claim second device loses", c2.get("claimed") is False, c2)
st, c3 = call("POST", "/api/payments/claim", S, {"ref_no": "BANKREF123"})
check("claim on posted sale refused", c3.get("claimed") is False, c3)

# 4. discount above RM50 needs admin PIN; audit row written server-side
big = {"items": [{"product_id": pid, "qty": 1}], "method": "CASH",
       "tendered_cents": 4000, "discount_cents": 6000, "client_ref": "ref-uuid-4"}
st, r = call("POST", "/api/sales", S, big)
check("staff big discount without PIN -> 403", st == 403, (st, r))
st, r = call("POST", "/api/sales", S, dict(big, admin_pin="888888"))
check("staff big discount with admin PIN -> ok", st == 200, (st, r))

# 5. held payload sanitisation
st, h = call("POST", "/api/held", A, {"payload": {"items": [
    {"product_id": pid, "qty": "<script>alert(1)</script>", "price_cents": 100}]}})
check("held script qty -> 400", st == 400, (st, h))
st, h = call("POST", "/api/held", A, {"payload": {"items": [
    {"product_id": pid, "qty": 2, "price_cents": 100, "name": "<img src=x onerror=alert(1)>"}]}})
check("held normal create ok", st == 200, h)
st, hl = call("GET", "/api/held", A)
it = (hl.get("items") or [{}])[0]
pl = it.get("payload") or {}
if isinstance(pl, str):
    pl = json.loads(pl)
items = pl.get("items") or []
check("held stored qty is a number", items and isinstance(items[0].get("qty"), (int, float)), items)

# 6. credit + repay methods + dashboard/closing splits
st, cust = call("POST", "/api/customers", A, {"name": "REG-CUST", "phone": "0123"})
cid = cust.get("id", 0)
cs = {"items": [{"product_id": pid, "qty": 1}], "method": "CREDIT",
      "customer_id": cid, "paid_cents": 2000, "deposit_method": "CASH",
      "client_ref": "ref-uuid-5"}
st, csale = call("POST", "/api/sales", A, cs)
csid = csale.get("id", 0)
check("credit sale created", st == 200 and csid > 0, csale)
st, r = call("POST", f"/api/credit/{csid}/repay", A, {"amount_cents": 4000, "method": "DUITNOW"})
check("repay DUITNOW ok", st == 200, r)
st, r = call("POST", f"/api/credit/{csid}/repay", A, {"amount_cents": 1000, "method": "CASH"})
check("repay CASH ok", st == 200, r)
st, r = call("POST", f"/api/credit/{csid}/repay", A, {"amount_cents": 100, "method": "CHEQUE"})
check("repay bad method -> 400", st == 400, (st, r))
import datetime
today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime("%Y-%m-%d")
st, dash = call("GET", "/api/dashboard", A)
check("dashboard loads", st == 200, dash)
st, clo = call("POST", "/api/closings", A, {"business_date": today, "counted_cash_cents": 0})
_cl = clo.get("closing") or {}
bd = ((_cl.get("payload") or _cl).get("cash_breakdown_cents") or {})
check("closing cash repayments = cash only (1000)",
      bd.get("repayments") == 1000, bd)
rbm = bd.get("repayments_by_method") or {}
check("closing repayments_by_method split",
      rbm.get("DUITNOW") == 4000 and rbm.get("CASH") == 1000, rbm)
st, r = call("POST", "/api/closings", A, {"business_date": "30/10/2026", "counted_cash_cents": 0})
check("closing bad date -> 400", st == 400, (st, r))

# 7. staff restrictions: cost hidden + admin-only reads
st, prods = call("GET", "/api/products", S)
row = [x for x in prods.get("items", []) if x.get("id") == pid]
check("staff cannot see cost", row and row[0].get("cost_cents") is None, row)
for path in ("/api/reports/monthly", "/api/reports/summary", "/api/purchases", "/api/closings"):
    st, _ = call("GET", path, S)
    check("staff 403 " + path, st == 403, st)

# 8. non-object JSON body -> 400 not 500
st, r = call("POST", "/api/sales", A, raw_body="[1,2,3]")
check("array body -> 400", st == 400, (st, r))

# 9. backup v2 completeness + restore round-trip
st, bak = call("GET", "/api/export/backup.json", A)
check("backup format v2", bak.get("format") == "pos2-backup-v2", bak.get("format"))
tables = bak.get("tables", {})
check("backup keeps pin hashes", any(u.get("pin_hash") for u in tables.get("users", [])), "no hash")
check("backup has audit_logs + aliases + drafts",
      all(k in tables for k in ("audit_logs", "supplier_product_aliases", "purchase_drafts", "barcode_queue")), list(tables.keys()))
check("discount audit row written server-side",
      any(r.get("action") in ("order_discount", "line_discount") for r in tables.get("audit_logs", [])),
      [r.get("action") for r in tables.get("audit_logs", [])])
st, pz = call("POST", "/api/products", A, {"name": "REG-Z-TEMP", "price_cents": 100})
zid = pz.get("id", 0)
st, rr = call("POST", "/api/admin/restore", A, {"backup": bak, "pin": "888888"})
check("restore ok", st == 200, rr)
st, _ = call("GET", "/api/products", A)
check("old token dead after restore", st == 401, st)
A2 = login("admin", "888888")
check("re-login after restore", bool(A2))
st, prods = call("GET", "/api/products?include_inactive=1", A2)
check("temp product gone after restore", all(x.get("id") != zid for x in prods.get("items", [])), zid)
A = A2

# 10. PIN change kills that user's sessions
S1 = login("staff", "666666")
check("staff login pre-change", bool(S1))
st, users = call("GET", "/api/users", A)
staff_row = [u for u in users.get("users", []) if u.get("username") == "staff"][0]
st, r = call("POST", "/api/users", A, {"id": staff_row.get("id"), "username": "staff",
                                       "display_name": "员工", "role": "STAFF", "pin": "777777"})
check("admin sets staff PIN", st == 200, r)
st, _ = call("GET", "/api/products", S1)
check("old staff session killed by PIN change", st == 401, st)
S2 = login("staff", "777777")
check("staff login with new PIN", bool(S2))

# 11. CSV formula-injection guard
call("POST", "/api/products", A, {"name": "=2+5cmd", "price_cents": 100})
st, csv = call("GET", "/api/export/products.csv", A)
body = csv if isinstance(csv, str) else json.dumps(csv)
check("csv formula cell neutralised", "'=2+5" in body or '"\'=2+5' in body, body[:200])

# 12. wipe requires PIN and snapshots first
st, r = call("POST", "/api/admin/wipe", A, {"category": "customers"})
check("wipe without PIN -> 403", st == 403, (st, r))
st, r = call("POST", "/api/admin/wipe", A, {"category": "customers", "pin": "888888"})
check("wipe with PIN ok + snapshot named", st == 200 and bool(r.get("backup")), r)

print()
print(f"=== REGRESS: {len(PASS)} passed, {len(FAIL)} failed ===")
if FAIL:
    print("FAILED:", FAIL)
    sys.exit(1)
