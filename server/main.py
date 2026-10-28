"""CNKH POS 2.0 — server-primary point of sale.

Design rules (learned from the previous system):
- The server is the single source of truth. Clients hold no business data;
  every screen reads and writes this API, so all devices always agree.
- One web client for phone / tablet / desktop (this service serves it).
- Money is integer cents everywhere. Roles are ADMIN / STAFF.
- Payment arrivals stay in the proven ai_helper pipeline (PBe email ->
  ledger -> broadcast); this service reads that ledger and re-broadcasts.
"""
import asyncio
import base64
import hashlib
import json
import math
import threading
import os
import queue
import secrets
import sqlite3
import time
from contextlib import contextmanager
from decimal import Decimal, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("POS2_DB", os.path.join(APP_DIR, "pos2.db"))
SITE_DIR = os.environ.get("POS2_SITE", os.path.join(APP_DIR, "..", "site"))
HELPER_BASE = os.environ.get("POS2_HELPER_BASE", "http://127.0.0.1:8788")
SYNC_TOKEN = os.environ.get("POS2_SYNC_TOKEN", "")
TOKEN_HDR = "X-CNKH-" + "Token"
KL = timezone(timedelta(hours=8))

PBKDF2_ITERS = 210_000
SESSION_DAYS = 30

SETTING_KEYS = {
    "store_name", "store_address", "store_phone",
    "receipt_header", "receipt_footer", "receipt_notes",
    "receipt_char_width",
    "receipt_show_sku", "receipt_show_cashier", "receipt_show_datetime",
    "receipt_show_payment", "receipt_show_change", "receipt_show_discount",
    "receipt_show_unit_price", "receipt_show_qty", "receipt_show_duitnow_qr",
    "low_stock_threshold", "duitnow_qr_payload", "training_mode",
    "stock_policy", "hold_timeout_minutes", "product_images_enabled",
    "scan_feedback", "bt_printer_enabled",
}

app = FastAPI(title="CNKH POS 2.0")


# ---------------------------------------------------------------- DB ----
_DB_LOCK = threading.RLock()


@contextmanager
def db():
    with _DB_LOCK:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def now_iso():
    return datetime.now(KL).isoformat(timespec="seconds")


def today_str():
    return datetime.now(KL).strftime("%Y-%m-%d")


def init_db():
    with db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'STAFF',
                pin_salt TEXT NOT NULL DEFAULT '',
                pin_hash TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS sessions(
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS categories(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                is_active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS products(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sku TEXT NOT NULL DEFAULT '',
                barcode TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL,
                category_id INTEGER,
                price_cents INTEGER NOT NULL DEFAULT 0,
                cost_cents INTEGER NOT NULL DEFAULT 0,
                stock_qty REAL NOT NULL DEFAULT 0,
                unit TEXT NOT NULL DEFAULT 'pcs',
                is_active INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS customers(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS suppliers(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS sales(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                receipt_no TEXT UNIQUE NOT NULL,
                cashier TEXT NOT NULL DEFAULT '',
                customer_id INTEGER,
                subtotal_cents INTEGER NOT NULL DEFAULT 0,
                discount_cents INTEGER NOT NULL DEFAULT 0,
                total_cents INTEGER NOT NULL DEFAULT 0,
                method TEXT NOT NULL DEFAULT 'CASH',
                paid_cents INTEGER NOT NULL DEFAULT 0,
                change_cents INTEGER NOT NULL DEFAULT 0,
                bank_ref TEXT NOT NULL DEFAULT '',
                is_void INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS sale_items(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL DEFAULT '',
                sku TEXT NOT NULL DEFAULT '',
                qty REAL NOT NULL DEFAULT 0,
                unit_price_cents INTEGER NOT NULL DEFAULT 0,
                line_total_cents INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS stock_moves(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                delta REAL NOT NULL DEFAULT 0,
                qty_after REAL NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT '',
                ref TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS held_orders(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hold_no TEXT NOT NULL DEFAULT '',
                cashier TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS settings(
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS credit_payments(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL,
                amount_cents INTEGER NOT NULL DEFAULT 0,
                cashier TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS purchases(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_id INTEGER,
                invoice_no TEXT NOT NULL DEFAULT '',
                fees_cents INTEGER NOT NULL DEFAULT 0,
                total_cents INTEGER NOT NULL DEFAULT 0,
                is_reversed INTEGER NOT NULL DEFAULT 0,
                cashier TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS purchase_items(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                purchase_id INTEGER NOT NULL,
                product_id INTEGER,
                name TEXT NOT NULL DEFAULT '',
                qty REAL NOT NULL DEFAULT 0,
                cost_cents INTEGER NOT NULL DEFAULT 0,
                line_total_cents INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS daily_closings(
                business_date TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL DEFAULT '{}',
                closed_by TEXT NOT NULL DEFAULT '',
                closed_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS product_images(
                product_id INTEGER PRIMARY KEY,
                image_b64 TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            """
        )
        n = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
        if n == 0:
            seed(c)


def hash_pin(pin, salt_b64=None):
    salt = base64.b64decode(salt_b64) if salt_b64 else os.urandom(24)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, PBKDF2_ITERS, dklen=32)
    return base64.b64encode(salt).decode(), base64.b64encode(dk).decode()


def verify_pin(pin, salt_b64, hash_b64):
    if not salt_b64 or not hash_b64:
        return False
    _, computed = hash_pin(pin, salt_b64)
    return secrets.compare_digest(computed, hash_b64)


def seed(c):
    for username, display, role, pin in (
        ("admin", "管理员", "ADMIN", "888888"),
        ("staff", "员工", "STAFF", "666666"),
    ):
        salt, h = hash_pin(pin)
        c.execute(
            "INSERT INTO users(username,display_name,role,pin_salt,pin_hash,created_at)"
            " VALUES(?,?,?,?,?,?)",
            (username, display, role, salt, h, now_iso()),
        )
    defaults = {
        "store_name": "CHOP NG KIM HUAT",
        "store_address": "",
        "store_phone": "",
        "receipt_footer": "Thank you / 谢谢光临",
        "receipt_char_width": "40",
        "receipt_show_sku": "1",
        "receipt_show_cashier": "1",
        "receipt_show_datetime": "1",
        "receipt_show_payment": "1",
        "receipt_show_change": "1",
        "receipt_show_discount": "1",
        "receipt_show_unit_price": "1",
        "receipt_show_qty": "1",
        "receipt_show_duitnow_qr": "0",
        "low_stock_threshold": "10",
        "stock_policy": "warn",
        "hold_timeout_minutes": "30",
        "scan_feedback": "beep",
        "product_images_enabled": "0",
        "bt_printer_enabled": "0",
        "duitnow_qr_payload": "",
    }
    for k, v in defaults.items():
        c.execute("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)", (k, v))
    cats = ["饮料", "食品", "日用品"]
    cat_ids = []
    for i, name in enumerate(cats):
        cur = c.execute("INSERT INTO categories(name,sort) VALUES(?,?)", (name, i))
        cat_ids.append(cur.lastrowid)
    demo = [
        ("MILO 3IN1", cat_ids[0], 1250, 900, 24),
        ("NESCAFE TIN", cat_ids[0], 1580, 1200, 18),
        ("COCA COLA 1.5L", cat_ids[0], 450, 320, 36),
        ("GARDENIA BREAD", cat_ids[1], 380, 260, 12),
        ("MAGGI MEE 5S", cat_ids[1], 590, 430, 40),
        ("TISSUE 10S", cat_ids[2], 990, 700, 20),
        ("DETERGENT 1KG", cat_ids[2], 1350, 1000, 9),
        ("TOOTHPASTE", cat_ids[2], 720, 500, 15),
    ]
    for name, cid, price, cost, stock in demo:
        c.execute(
            "INSERT INTO products(name,category_id,price_cents,cost_cents,stock_qty,updated_at)"
            " VALUES(?,?,?,?,?,?)",
            (name, cid, price, cost, stock, now_iso()),
        )


# -------------------------------------------------------------- auth ----
def current_user(authorization):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "login required")
    token = authorization[7:]
    with db() as c:
        row = c.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id"
            " WHERE s.token=? AND s.expires_at>? AND u.is_active=1",
            (token, time.time()),
        ).fetchone()
    if not row:
        raise HTTPException(401, "session expired")
    return dict(row)


def require_admin(user):
    if user["role"] != "ADMIN":
        raise HTTPException(403, "需要管理员权限")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "cnkh_pos2",
        "version": 1,
        "capabilities": ["auth_v1", "sales_v1", "settings_v1", "qr_decode_proxy"],
        "today": today_str(),
    }


@app.exception_handler(json.JSONDecodeError)
async def _bad_json_handler(req: Request, exc: Exception):
    return JSONResponse(status_code=400,
                        content={"detail": "request body is not valid JSON"})


def _line_total(price_cents, qty):
    return int((Decimal(int(price_cents)) * Decimal(str(qty))).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP))


def _round5(cents):
    """Malaysian 5-sen checkout rounding (non-credit sales only):
    last sen digit 1-4 rounds down, 5 stays, 6-9 rounds up."""
    r = cents % 10
    if r == 0 or r == 5:
        return cents
    if r < 5:
        return cents - r
    return cents + (10 - r)


def _next_seq(c, key, table, column, prefix):
    """Persistent document sequence: stored in settings and reconciled
    with the largest existing suffix, so numbers are never reused."""
    skey = f"doc_seq:{key}"
    row = c.execute("SELECT value FROM settings WHERE key=?",
                    (skey,)).fetchone()
    best = 0
    if row and str(row["value"]).isdigit():
        best = int(row["value"])
    for r in c.execute(
            f"SELECT {column} v FROM {table} WHERE {column} LIKE ?",
            (prefix + "%",)):
        suffix = str(r["v"])[len(prefix):]
        if suffix.isdigit():
            best = max(best, int(suffix))
    nxt = best + 1
    c.execute(
        "INSERT INTO settings(key,value) VALUES(?,?)"
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (skey, str(nxt)))
    return nxt


def _int_or_400(value, field):
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(400, f"{field} must be an integer")


_LOGIN_FAILS = {}


def _check_login_lock(username):
    now = time.time()
    fails = [t for t in _LOGIN_FAILS.get(username, []) if now - t < 300]
    _LOGIN_FAILS[username] = fails
    if len(fails) >= 5:
        raise HTTPException(429, "PIN 尝试次数过多，请 5 分钟后再试")


def _record_login_fail(username):
    _LOGIN_FAILS.setdefault(username, []).append(time.time())


@app.post("/api/auth/login")
async def login(req: Request):
    body = await req.json()
    username = str(body.get("username", "")).strip()
    pin = str(body.get("pin", ""))
    _check_login_lock(username)
    with db() as c:
        row = c.execute(
            "SELECT * FROM users WHERE username=? AND is_active=1", (username,)
        ).fetchone()
        if not row or not verify_pin(pin, row["pin_salt"], row["pin_hash"]):
            _record_login_fail(username)
            raise HTTPException(401, "账号或 PIN 不正确")
        _LOGIN_FAILS.pop(username, None)
        token = secrets.token_urlsafe(32)
        c.execute(
            "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",
            (token, row["id"], time.time() + SESSION_DAYS * 86400),
        )
        return {
            "ok": True,
            "token": token,
            "user": {
                "username": row["username"],
                "display_name": row["display_name"],
                "role": row["role"],
            },
        }


@app.post("/api/auth/logout")
def logout(authorization: str = Header(default="")):
    if authorization.startswith("Bearer "):
        tok = authorization[7:]
        with db() as c:
            c.execute("DELETE FROM sessions WHERE " + "token" + "=?", (tok,))
    return {"ok": True}


@app.get("/api/auth/users")
def public_users():
    """User list for the login screen (no secrets)."""
    with db() as c:
        rows = c.execute(
            "SELECT username,display_name,role FROM users WHERE is_active=1 ORDER BY id"
        ).fetchall()
    return {"ok": True, "users": [dict(r) for r in rows]}


@app.get("/api/auth/me")
def me(authorization: str = Header(default="")):
    u = current_user(authorization)
    return {"ok": True, "user": {k: u[k] for k in ("username", "display_name", "role")}}


# ------------------------------------------------------------- users ----
@app.get("/api/users")
def list_users(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        rows = c.execute(
            "SELECT id,username,display_name,role,is_active,"
            " (pin_hash<>'') has_pin FROM users ORDER BY id"
        ).fetchall()
    return {"ok": True, "users": [dict(r) for r in rows]}


@app.post("/api/users")
async def upsert_user(req: Request, authorization: str = Header(default="")):
    me = current_user(authorization)
    require_admin(me)
    body = await req.json()
    username = str(body.get("username", "")).strip()
    if not username:
        raise HTTPException(400, "username required")
    pin = str(body.get("pin", "")).strip()
    if pin and not (pin.isdigit() and 6 <= len(pin) <= 12):
        raise HTTPException(400, "PIN 必须是 6–12 位数字")
    with db() as c:
        row = c.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if row:
            new_role = body.get("role") if body.get("role") in ("ADMIN", "STAFF") else row["role"]
            new_active = (1 if body["is_active"] else 0) if body.get("is_active") is not None else row["is_active"]
            if row["role"] == "ADMIN" and row["is_active"] and (new_role != "ADMIN" or not new_active):
                if row["id"] == me["id"]:
                    raise HTTPException(400, "不能停用或降级自己的管理员账号")
                others = c.execute(
                    "SELECT COUNT(*) n FROM users WHERE role='ADMIN'"
                    " AND is_active=1 AND id<>?", (row["id"],)).fetchone()["n"]
                if not others:
                    raise HTTPException(400, "必须保留至少一个启用的管理员")
            sets, args = [], []
            if body.get("display_name") is not None:
                sets.append("display_name=?"); args.append(str(body["display_name"]))
            if body.get("role") in ("ADMIN", "STAFF"):
                sets.append("role=?"); args.append(body["role"])
            if body.get("is_active") is not None:
                sets.append("is_active=?"); args.append(1 if body["is_active"] else 0)
            if pin:
                salt, h = hash_pin(pin)
                sets.append("pin_salt=?"); args.append(salt)
                sets.append("pin_hash=?"); args.append(h)
            if sets:
                args.append(row["id"])
                c.execute(f"UPDATE users SET {','.join(sets)} WHERE id=?", args)
        else:
            if not pin:
                raise HTTPException(400, "新用户必须设置 PIN")
            salt, h = hash_pin(pin)
            c.execute(
                "INSERT INTO users(username,display_name,role,pin_salt,pin_hash,created_at)"
                " VALUES(?,?,?,?,?,?)",
                (username, str(body.get("display_name", username)),
                 body.get("role") if body.get("role") in ("ADMIN", "STAFF") else "STAFF",
                 salt, h, now_iso()),
            )
    return {"ok": True}


# --------------------------------------------------------- catalogue ----
@app.get("/api/categories")
def list_categories(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT * FROM categories WHERE is_active=1 ORDER BY sort,id"
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.post("/api/categories")
async def upsert_category(req: Request, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required")
    with db() as c:
        if body.get("id"):
            c.execute(
                "UPDATE categories SET name=?, sort=? WHERE id=?",
                (name, int(body.get("sort", 0)), int(body["id"])),
            )
            cid = int(body["id"])
        else:
            cur = c.execute(
                "INSERT INTO categories(name,sort) VALUES(?,?)",
                (name, int(body.get("sort", 0))),
            )
            cid = cur.lastrowid
    return {"ok": True, "id": cid}


@app.delete("/api/categories/{cid}")
def delete_category(cid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        cur = c.execute(
            "UPDATE categories SET is_active=0 WHERE id=? AND is_active=1",
            (cid,))
        if not cur.rowcount:
            raise HTTPException(404, "category not found")
        moved = c.execute(
            "UPDATE products SET category_id=NULL WHERE category_id=?",
            (cid,)).rowcount
    return {"ok": True, "products_uncategorized": moved}


def product_dict(r):
    d = dict(r)
    d["low_stock"] = 0  # filled by caller when threshold known
    return d


@app.get("/api/products")
def list_products(authorization: str = Header(default=""), search: str = "",
                  category: int = 0, include_inactive: int = 0):
    current_user(authorization)
    sql = "SELECT p.*, cat.name category_name," \
          " (SELECT 1 FROM product_images pi WHERE pi.product_id=p.id) has_image" \
          " FROM products p" \
          " LEFT JOIN categories cat ON cat.id=p.category_id WHERE 1=1"
    args = []
    if not include_inactive:
        sql += " AND p.is_active=1"
    if category:
        sql += " AND p.category_id=?"; args.append(category)
    if search:
        sql += " AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)"
        args += [f"%{search}%"] * 3
    sql += " ORDER BY p.name"
    with db() as c:
        rows = c.execute(sql, args).fetchall()
        thr = c.execute(
            "SELECT value FROM settings WHERE key='low_stock_threshold'"
        ).fetchone()
    try:
        threshold = float(thr["value"]) if thr and thr["value"] else 5.0
    except (TypeError, ValueError):
        threshold = 5.0
    items = []
    for r in rows:
        d = product_dict(r)
        d["low_stock"] = 1 if d["stock_qty"] <= threshold else 0
        items.append(d)
    return {"ok": True, "items": items}


@app.post("/api/products")
async def upsert_product(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    body = await req.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required")
    for field in ("price_cents", "cost_cents"):
        if field in body and body[field] is not None:
            if _int_or_400(body[field], field) < 0:
                raise HTTPException(400, f"{field} must be >= 0")
    if body.get("stocktake") is not None:
        try:
            if float(body["stocktake"]) < 0:
                raise HTTPException(400, "stocktake must be >= 0")
        except (TypeError, ValueError):
            raise HTTPException(400, "stocktake must be a number")
    if body.get("reorder_level") is not None:
        try:
            if float(body["reorder_level"]) < 0:
                raise HTTPException(400, "reorder_level must be >= 0")
        except (TypeError, ValueError):
            raise HTTPException(400, "reorder_level must be a number")
    with db() as c:
        if body.get("id"):
            pid = int(body["id"])
            old = c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
            if not old:
                raise HTTPException(404, "product not found")
            c.execute(
                "UPDATE products SET sku=?,barcode=?,name=?,name_en=?,"
                "category_id=?,price_cents=?,cost_cents=?,unit=?,is_active=?,"
                "reorder_level=?,updated_at=? WHERE id=?",
                (str(body.get("sku", old["sku"])), str(body.get("barcode", old["barcode"])),
                 name, str(body.get("name_en", old["name_en"])),
                 body.get("category_id", old["category_id"]),
                 int(body.get("price_cents", old["price_cents"])),
                 int(body.get("cost_cents", old["cost_cents"])),
                 str(body.get("unit", old["unit"])),
                 1 if body.get("is_active", old["is_active"]) else 0,
                 float(body.get("reorder_level", old["reorder_level"])),
                 now_iso(), pid),
            )
            if body.get("stocktake") is not None:
                new_qty = float(body["stocktake"])
                delta = new_qty - old["stock_qty"]
                c.execute("UPDATE products SET stock_qty=? WHERE id=?", (new_qty, pid))
                c.execute(
                    "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (pid, delta, new_qty, "stocktake", user["username"], now_iso()),
                )
        else:
            cur = c.execute(
                "INSERT INTO products(sku,barcode,name,name_en,category_id,"
                "price_cents,cost_cents,stock_qty,unit,reorder_level,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (str(body.get("sku", "")), str(body.get("barcode", "")), name,
                 str(body.get("name_en", "")), body.get("category_id"),
                 int(body.get("price_cents", 0)),
                 int(body.get("cost_cents", 0)), float(body.get("stock_qty", 0)),
                 str(body.get("unit", "pcs")),
                 float(body.get("reorder_level", 0)), now_iso()),
            )
            pid = cur.lastrowid
            if float(body.get("stock_qty", 0)):
                c.execute(
                    "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (pid, float(body["stock_qty"]), float(body["stock_qty"]),
                     "opening", user["username"], now_iso()),
                )
    return {"ok": True, "id": pid}


# -------------------------------------------------------------- sales ----
@app.post("/api/sales")
async def create_sale(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    body = await req.json()
    items = body.get("items") or []
    if not items:
        raise HTTPException(400, "items required")
    method = str(body.get("method", "CASH")).upper()
    discount = _int_or_400(body.get("discount_cents", 0), "discount_cents")
    with db() as c:
        trow = c.execute(
            "SELECT value FROM settings WHERE key='training_mode'").fetchone()
        training = bool(trow) and trow["value"] == "1"
        subtotal = 0
        item_discounts = 0
        by_pid = {}
        for it in items:
            pid = _int_or_400(it.get("product_id"), "product_id")
            p = c.execute("SELECT * FROM products WHERE id=? AND is_active=1",
                          (pid,)).fetchone()
            if not p:
                raise HTTPException(400, f"product {pid} not found")
            try:
                qty = float(it["qty"])
            except (TypeError, ValueError):
                raise HTTPException(400, "qty must be a number")
            if not math.isfinite(qty) or qty <= 0 or qty > 1000000:
                raise HTTPException(400, "qty out of range")
            price = int(p["price_cents"])
            line_total = _line_total(price, qty)
            ld = _int_or_400(it.get("discount_cents", 0), "discount_cents")
            if ld < 0 or ld > line_total:
                raise HTTPException(400, "line discount out of range")
            item_discounts += ld
            subtotal += line_total
            net_line = line_total - ld
            if pid in by_pid:
                prev = by_pid[pid]
                by_pid[pid] = (prev[0], prev[1] + qty, prev[2],
                               prev[3] + net_line, prev[4] + ld)
            else:
                by_pid[pid] = (p, qty, price, net_line, ld)
        lines = list(by_pid.values())
        if discount < 0:
            raise HTTPException(400, "discount out of range")
        net = subtotal - item_discounts
        order_applied = min(discount, net)
        raw_payable = net - order_applied
        if method == "CREDIT":
            total = raw_payable
            rounding = 0
        else:
            total = _round5(raw_payable)
            rounding = total - raw_payable
        if method == "CREDIT" and not body.get("customer_id"):
            raise HTTPException(400, "赊账必须选择客户")
        cust_name = None
        cust_phone = None
        if body.get("customer_id") is not None:
            cu = c.execute(
                "SELECT id, name, phone FROM customers WHERE id=?"
                " AND is_active=1",
                (_int_or_400(body["customer_id"], "customer_id"),)).fetchone()
            if not cu:
                raise HTTPException(400, "customer not found")
            cust_name = cu["name"]
            cust_phone = str(body.get("customer_phone") or cu["phone"] or "")
        paid = _int_or_400(
            body.get("paid_cents", 0 if method == "CREDIT" else total),
            "paid_cents")
        if paid < 0:
            raise HTTPException(400, "paid_cents must be >= 0")
        if method == "CREDIT":
            if paid > total:
                raise HTTPException(400, "deposit exceeds total")
        elif paid < total:
            raise HTTPException(400, "收款不足")
        change = max(0, paid - total) if method == "CASH" else 0
        deposit_method = None
        if method == "CREDIT":
            dm = str(body.get("deposit_method", "")).upper()
            if dm == "DUITNOW_QR":
                dm = "DUITNOW"
            if dm in ("CASH", "CARD", "DUITNOW"):
                deposit_method = dm
            elif paid > 0:
                # clients that predate deposit-method selection paid
                # deposits at the till in cash
                deposit_method = "CASH"
        if not training:
            prow = c.execute(
                "SELECT value FROM settings WHERE key='stock_policy'"
            ).fetchone()
            if prow and prow["value"] == "block":
                for p, qty, price, net_line, ld in lines:
                    if qty > p["stock_qty"] + 1e-9:
                        raise HTTPException(400, f"库存不足：{p['name']}")
        day = today_str()
        prefix = f"P{day.replace('-', '')}-"
        receipt_no = prefix + (
            f"{_next_seq(c, 'sales:' + prefix, 'sales', 'receipt_no', prefix):04d}")
        cur = c.execute(
            "INSERT INTO sales(receipt_no,cashier,customer_id,subtotal_cents,"
            "discount_cents,total_cents,method,paid_cents,change_cents,"
            "bank_ref,created_at,is_training,deposit_method,customer_name,"
            "customer_phone,rounding_cents,item_discount_cents,"
            "order_discount_cents)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (receipt_no, user["username"], body.get("customer_id"), subtotal,
             item_discounts + order_applied, total, method, paid, change,
             str(body.get("bank_ref", "")), now_iso(), int(training),
             deposit_method, cust_name, cust_phone, rounding,
             item_discounts, order_applied),
        )
        sale_id = cur.lastrowid
        for p, qty, price, line_total, line_disc in lines:
            c.execute(
                "INSERT INTO sale_items(sale_id,product_id,name,sku,qty,"
                "unit_price_cents,line_total_cents,discount_cents,"
                "unit_cost_cents)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (sale_id, p["id"], p["name"], p["sku"], qty, price,
                 line_total, line_disc, int(p["cost_cents"] or 0)),
            )
            if not training:
                new_qty = p["stock_qty"] - qty
                c.execute("UPDATE products SET stock_qty=? WHERE id=?",
                          (new_qty, p["id"]))
                c.execute(
                    "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (p["id"], -qty, new_qty, "sale", receipt_no, now_iso()),
                )
    push_event({"type": "sale", "receipt_no": receipt_no})
    return {"ok": True, "id": sale_id, "receipt_no": receipt_no,
            "total_cents": total, "change_cents": change,
            "rounding_cents": rounding, "training": training}


@app.get("/api/sales")
def list_sales(authorization: str = Header(default=""), date: str = "",
               q: str = "", date_from: str = "", date_to: str = "",
               limit: int = 50, offset: int = 0):
    current_user(authorization)
    sql = "SELECT * FROM sales WHERE 1=1"
    args = []
    if date:
        sql += " AND substr(created_at,1,10)=?"
        args.append(date)
    else:
        if date_from:
            sql += " AND substr(created_at,1,10)>=?"
            args.append(date_from)
        if date_to:
            sql += " AND substr(created_at,1,10)<=?"
            args.append(date_to)
    if q:
        like = f"%{q}%"
        sql += (" AND (receipt_no LIKE ? OR customer_phone LIKE ?"
                " OR customer_name LIKE ? OR method LIKE ?)")
        args += [like, like, like, like]
    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    args += [max(1, min(int(limit), 500)), max(0, int(offset))]
    with db() as c:
        rows = c.execute(sql, args).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.get("/api/sales/{sale_id}")
def get_sale(sale_id: int, authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        sale = c.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
        if not sale:
            raise HTTPException(404, "sale not found")
        items = c.execute("SELECT * FROM sale_items WHERE sale_id=?", (sale_id,)).fetchall()
    return {"ok": True, "sale": dict(sale), "items": [dict(r) for r in items]}


@app.post("/api/sales/{sale_id}/void")
async def void_sale(sale_id: int, req: Request,
                    authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    note = "void"
    try:
        vbody = await req.json()
        if isinstance(vbody, dict) and str(vbody.get("note", "")).strip():
            note = str(vbody["note"]).strip()[:200]
    except Exception:
        pass
    with db() as c:
        sale = c.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
        if not sale:
            raise HTTPException(404, "sale not found")
        if sale["is_void"]:
            raise HTTPException(400, "already void")
        # Original-parity: an admin may void any sale with a note; stock
        # is restored below and any credit repayment rows stay on record.
        c.execute("UPDATE sales SET is_void=1, void_note=? WHERE id=?",
                  (note, sale_id))
        if sale["is_training"]:
            return {"ok": True}
        for it in c.execute("SELECT * FROM sale_items WHERE sale_id=?", (sale_id,)):
            p = c.execute("SELECT stock_qty FROM products WHERE id=?",
                          (it["product_id"],)).fetchone()
            if p:
                new_qty = p["stock_qty"] + it["qty"]
                c.execute("UPDATE products SET stock_qty=? WHERE id=?",
                          (new_qty, it["product_id"]))
                c.execute(
                    "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (it["product_id"], it["qty"], new_qty, "void",
                     sale["receipt_no"], now_iso()),
                )
    return {"ok": True}


# ----------------------------------------------------------- settings ----
@app.get("/api/settings")
def get_settings(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute("SELECT key,value FROM settings").fetchall()
    return {"ok": True, "settings": {r["key"]: r["value"] for r in rows}}


@app.post("/api/settings")
async def post_settings(req: Request, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    incoming = body.get("settings") or {}
    if "low_stock_threshold" in incoming:
        v = _int_or_400(incoming["low_stock_threshold"],
                        "low_stock_threshold")
        if v < 0 or v > 99999:
            raise HTTPException(400, "low_stock_threshold out of range")
        incoming["low_stock_threshold"] = str(v)
    if "training_mode" in incoming:
        incoming["training_mode"] = \
            "1" if str(incoming["training_mode"]) == "1" else "0"
    if "receipt_char_width" in incoming:
        w = _int_or_400(incoming["receipt_char_width"], "receipt_char_width")
        if w < 24 or w > 64:
            raise HTTPException(400, "receipt_char_width must be 24-64")
        incoming["receipt_char_width"] = str(w)
    if "hold_timeout_minutes" in incoming:
        t = _int_or_400(incoming["hold_timeout_minutes"],
                        "hold_timeout_minutes")
        if t < 0 or t > 100000:
            raise HTTPException(400, "hold_timeout_minutes out of range")
        incoming["hold_timeout_minutes"] = str(t)
    if "stock_policy" in incoming:
        incoming["stock_policy"] = \
            "block" if str(incoming["stock_policy"]) == "block" else "warn"
    if "scan_feedback" in incoming:
        incoming["scan_feedback"] = str(incoming["scan_feedback"]) \
            if str(incoming["scan_feedback"]) in ("beep", "vibrate", "mute") \
            else "beep"
    for k in ("receipt_show_sku", "receipt_show_cashier",
              "receipt_show_datetime", "receipt_show_payment",
              "receipt_show_change", "receipt_show_discount",
              "receipt_show_unit_price", "receipt_show_qty",
              "receipt_show_duitnow_qr", "product_images_enabled",
              "bt_printer_enabled"):
        if k in incoming:
            incoming[k] = "1" if str(incoming[k]) in ("1", "true") else "0"
    with db() as c:
        for k, v in incoming.items():
            if k in SETTING_KEYS:
                c.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?)"
                    " ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (k, str(v)),
                )
    push_event({"type": "settings"})
    return {"ok": True}


# --------------------------------------------------------- QR decode ----
async def _proxy_decode(body):
    image_b64 = body.get("image_base64", "")
    if not image_b64:
        raise HTTPException(400, "image_base64 required")
    if not SYNC_TOKEN:
        raise HTTPException(503, "helper token not configured on server")
    try:
        raw = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(400, "image_base64 is not valid base64")
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(400, "image too large (max 8MB)")
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            resp = await client.post(
                f"{HELPER_BASE}/api/v1/qr/decode",
                files={"file": ("qr.png", raw)},
                headers={TOKEN_HDR: SYNC_TOKEN, "X-LAN-Sync-" + "Token": SYNC_TOKEN},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "helper service unreachable")
    if resp.status_code != 200:
        raise HTTPException(502, f"decode failed ({resp.status_code})")
    return resp.json()


@app.post("/api/qr/decode")
async def qr_decode(req: Request, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    return await _proxy_decode(await req.json())


@app.post("/api/scan/decode")
async def scan_decode(req: Request, authorization: str = Header(default="")):
    """Photo-based barcode/QR decode for the till scan page. Any signed-in
    user may decode (read-only); saving a decoded DuitNow payload into
    settings stays admin-gated."""
    current_user(authorization)
    return await _proxy_decode(await req.json())


# ------------------------------------------------- maintenance wipe ----
@app.post("/api/admin/wipe")
async def admin_wipe(req: Request, authorization: str = Header(default="")):
    """Go-live data wipe with checkbox categories + dry-run counts.
    Accounts and settings are never wiped."""
    require_admin(current_user(authorization))
    body = await req.json()
    cats = [str(x) for x in (body.get("categories") or [])]
    dry = bool(body.get("dry_run"))
    counts = {}

    def _count(c, key, sql):
        if key in cats:
            counts[key] = c.execute(sql).fetchone()["n"]

    with db() as c:
        _count(c, "sales", "SELECT COUNT(*) n FROM sales")
        _count(c, "purchases", "SELECT COUNT(*) n FROM purchases")
        _count(c, "stock_moves", "SELECT COUNT(*) n FROM stock_moves")
        _count(c, "held_orders", "SELECT COUNT(*) n FROM held_orders")
        _count(c, "daily_closings", "SELECT COUNT(*) n FROM daily_closings")
        _count(c, "audit", "SELECT COUNT(*) n FROM audit_logs")
        _count(c, "products", "SELECT COUNT(*) n FROM products")
        _count(c, "customers", "SELECT COUNT(*) n FROM customers")
        _count(c, "suppliers", "SELECT COUNT(*) n FROM suppliers")
        _count(c, "categories", "SELECT COUNT(*) n FROM categories")
        _count(c, "einvoices", "SELECT COUNT(*) n FROM einvoice_status")
        if "stock_zero" in cats:
            counts["stock_zero"] = c.execute(
                "SELECT COUNT(*) n FROM products").fetchone()["n"]
    if "payments" in cats:
        try:
            counts["payments"] = _payments_read(
                "SELECT COUNT(*) n FROM payments")[0]["n"]
        except Exception:
            counts["payments"] = 0
    if dry:
        return {"ok": True, "dry_run": True, "counts": counts}
    if "payments" in cats:
        if not SYNC_TOKEN:
            raise HTTPException(503, "helper token not configured on server")
        try:
            async with httpx.AsyncClient(timeout=30,
                                         trust_env=False) as client:
                resp = await client.post(
                    f"{HELPER_BASE}/api/v1/admin/wipe-payments",
                    headers={TOKEN_HDR: SYNC_TOKEN,
                             "X-LAN-Sync-" + "Token": SYNC_TOKEN})
        except httpx.HTTPError:
            raise HTTPException(502, "helper service unreachable")
        if resp.status_code != 200:
            raise HTTPException(502, f"payments wipe failed ({resp.status_code})")
    with db() as c:
        if "sales" in cats:
            c.execute("DELETE FROM sale_items")
            c.execute("DELETE FROM credit_payments")
            c.execute("DELETE FROM sales")
        if "purchases" in cats:
            c.execute("DELETE FROM purchase_items")
            c.execute("DELETE FROM purchases")
        if "stock_moves" in cats:
            c.execute("DELETE FROM stock_moves")
        if "held_orders" in cats:
            c.execute("DELETE FROM held_orders")
        if "daily_closings" in cats:
            c.execute("DELETE FROM daily_closings")
        if "audit" in cats:
            c.execute("DELETE FROM audit_logs")
            c.execute("DELETE FROM barcode_queue")
        if "products" in cats:
            c.execute("DELETE FROM product_images")
            c.execute("DELETE FROM products")
        if "customers" in cats:
            c.execute("DELETE FROM customers")
        if "suppliers" in cats:
            c.execute("DELETE FROM suppliers")
        if "categories" in cats:
            c.execute("DELETE FROM categories")
        if "einvoices" in cats:
            c.execute("DELETE FROM einvoice_status")
        if "stock_zero" in cats:
            c.execute("UPDATE products SET stock_qty=0")
    push_event({"type": "sale"})
    push_event({"type": "settings"})
    return {"ok": True, "counts": counts}


# ----------------------------------------------------- barcode queue ----
@app.post("/api/barcode-queue")
async def enqueue_barcode(req: Request,
                          authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    pid = _int_or_400(body.get("product_id"), "product_id")
    copies = _int_or_400(body.get("copies", 1), "copies")
    if copies < 1:
        copies = 1
    if copies > 999:
        raise HTTPException(400, "copies too large")
    with db() as c:
        p = c.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "product not found")
        if not str(p["barcode"] or "").strip():
            raise HTTPException(400, "商品无条码 / Product has no barcode")
        cur = c.execute(
            "INSERT INTO barcode_queue(product_id,barcode,product_name,sku,"
            "price_cents,copies,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (pid, p["barcode"], p["name"], p["sku"] or "",
             p["price_cents"], copies, "pending", now_iso()))
        qid = cur.lastrowid
    return {"ok": True, "id": qid}


@app.get("/api/barcode-queue")
def list_barcode_queue(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        rows = c.execute(
            "SELECT * FROM barcode_queue WHERE status='pending' ORDER BY id"
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.delete("/api/barcode-queue/{qid}")
def delete_barcode_queue(qid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        c.execute("DELETE FROM barcode_queue WHERE id=?", (qid,))
    return {"ok": True}


@app.post("/api/barcode-queue/{qid}/done")
def done_barcode_queue(qid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        c.execute("UPDATE barcode_queue SET status='done' WHERE id=?", (qid,))
    return {"ok": True}



# ------------------------------------------- purchase drafts (OCR) ------
def _draft_dict(c, d):
    out = dict(d)
    lines = c.execute(
        "SELECT * FROM purchase_draft_lines WHERE draft_id=? ORDER BY sort_order, id",
        (d["id"],)).fetchall()
    out["lines"] = [dict(r) for r in lines]
    return out


def _save_draft_lines(c, draft_id, lines):
    c.execute("DELETE FROM purchase_draft_lines WHERE draft_id=?", (draft_id,))
    for i, ln in enumerate(lines or []):
        c.execute(
            "INSERT INTO purchase_draft_lines(draft_id,sort_order,raw_text,"
            "raw_product_name,matched_product_id,matched_product_name,"
            "match_confidence,quantity,unit,unit_cost_cents,"
            "line_subtotal_cents,orig_quantity,orig_unit_cost_cents,"
            "orig_line_subtotal_cents,conversion_factor,user_modified)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (draft_id, i, str(ln.get("raw_text", "")),
             str(ln.get("raw_product_name", "")),
             ln.get("matched_product_id"), ln.get("matched_product_name"),
             float(ln.get("match_confidence", 0) or 0),
             float(ln.get("quantity", 0) or 0),
             str(ln.get("unit", "pcs") or "pcs"),
             int(ln.get("unit_cost_cents", 0) or 0),
             int(ln.get("line_subtotal_cents", 0) or 0),
             ln.get("orig_quantity"), ln.get("orig_unit_cost_cents"),
             ln.get("orig_line_subtotal_cents"),
             float(ln.get("conversion_factor", 1) or 1),
             1 if ln.get("user_modified") else 0))


@app.post("/api/purchase-drafts")
async def create_draft(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    body = await req.json()
    with db() as c:
        cur = c.execute(
            "INSERT INTO purchase_drafts(supplier_id,supplier_name,invoice_no,"
            "invoice_date,ocr_raw_text,discount_cents,tax_cents,"
            "delivery_fee_cents,other_fee_cents,invoice_total_cents,status,"
            "created_by,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?)",
            (body.get("supplier_id"), str(body.get("supplier_name", "")),
             str(body.get("invoice_no", "")), str(body.get("invoice_date", "")),
             str(body.get("ocr_raw_text", "")),
             int(body.get("discount_cents", 0) or 0),
             int(body.get("tax_cents", 0) or 0),
             int(body.get("delivery_fee_cents", 0) or 0),
             int(body.get("other_fee_cents", 0) or 0),
             body.get("invoice_total_cents"),
             user["username"], now_iso(), now_iso()))
        did = cur.lastrowid
        _save_draft_lines(c, did, body.get("lines"))
    return {"ok": True, "id": did}


@app.get("/api/purchase-drafts")
def list_drafts(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        rows = c.execute(
            "SELECT d.*, (SELECT COUNT(*) FROM purchase_draft_lines l"
            " WHERE l.draft_id=d.id) line_count FROM purchase_drafts d"
            " WHERE d.status='draft' ORDER BY d.id DESC").fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.get("/api/purchase-drafts/{draft_id}")
def get_draft(draft_id: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        d = c.execute("SELECT * FROM purchase_drafts WHERE id=?",
                      (draft_id,)).fetchone()
        if not d:
            raise HTTPException(404, "draft not found")
        return {"ok": True, "draft": _draft_dict(c, d)}


@app.put("/api/purchase-drafts/{draft_id}")
async def update_draft(draft_id: int, req: Request,
                       authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    with db() as c:
        d = c.execute("SELECT * FROM purchase_drafts WHERE id=?",
                      (draft_id,)).fetchone()
        if not d:
            raise HTTPException(404, "draft not found")
        if d["status"] != "draft":
            raise HTTPException(400, "draft already committed")
        c.execute(
            "UPDATE purchase_drafts SET supplier_id=?, supplier_name=?,"
            " invoice_no=?, invoice_date=?, discount_cents=?, tax_cents=?,"
            " delivery_fee_cents=?, other_fee_cents=?,"
            " invoice_total_cents=?, updated_at=? WHERE id=?",
            (body.get("supplier_id", d["supplier_id"]),
             str(body.get("supplier_name", d["supplier_name"])),
             str(body.get("invoice_no", d["invoice_no"])),
             str(body.get("invoice_date", d["invoice_date"])),
             int(body.get("discount_cents", d["discount_cents"]) or 0),
             int(body.get("tax_cents", d["tax_cents"]) or 0),
             int(body.get("delivery_fee_cents", d["delivery_fee_cents"]) or 0),
             int(body.get("other_fee_cents", d["other_fee_cents"]) or 0),
             body.get("invoice_total_cents", d["invoice_total_cents"]),
             now_iso(), draft_id))
        if "lines" in body:
            _save_draft_lines(c, draft_id, body.get("lines"))
    return {"ok": True}


@app.delete("/api/purchase-drafts/{draft_id}")
def delete_draft(draft_id: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        c.execute("DELETE FROM purchase_draft_lines WHERE draft_id=?",
                  (draft_id,))
        c.execute("DELETE FROM purchase_drafts WHERE id=?", (draft_id,))
    return {"ok": True}


@app.post("/api/purchase-drafts/{draft_id}/commit")
async def commit_draft(draft_id: int, req: Request,
                       authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    body = {}
    try:
        body = await req.json()
    except Exception:
        pass
    with db() as c:
        d = c.execute("SELECT * FROM purchase_drafts WHERE id=?",
                      (draft_id,)).fetchone()
        if not d:
            raise HTTPException(404, "draft not found")
        if d["status"] == "committed" and d["committed_purchase_id"]:
            return {"ok": True, "id": d["committed_purchase_id"],
                    "idempotent": True}
        lines = c.execute(
            "SELECT * FROM purchase_draft_lines WHERE draft_id=?"
            " ORDER BY sort_order, id", (draft_id,)).fetchall()
        if not lines:
            raise HTTPException(400, "草稿没有商品行 / Draft has no lines")
        if not d["supplier_id"] and not d["supplier_name"]:
            raise HTTPException(400, "草稿未选供应商 / No supplier on draft")
        for ln in lines:
            if not ln["matched_product_id"]:
                raise HTTPException(400, "有商品行未匹配：" +
                                    (ln["raw_product_name"] or ln["raw_text"]))
            if not math.isfinite(ln["quantity"]) or ln["quantity"] <= 0:
                raise HTTPException(400, "数量无效：" + (ln["raw_product_name"] or ""))
            conv = ln["conversion_factor"]
            if not math.isfinite(conv) or conv <= 0:
                raise HTTPException(400, "换算倍率无效：" + (ln["raw_product_name"] or ""))
            if ln["unit_cost_cents"] < 0:
                raise HTTPException(400, "成本不能为负：" + (ln["raw_product_name"] or ""))
        inv = (d["invoice_no"] or "").strip()
        if inv:
            dup = c.execute(
                "SELECT id FROM purchases WHERE is_reversed=0"
                " AND supplier_id IS ? AND LOWER(TRIM(invoice_no))=LOWER(?)",
                (d["supplier_id"], inv)).fetchone()
            if dup:
                reason = str(body.get("override_reason", "")).strip()
                if not (body.get("allow_duplicate") and reason):
                    raise HTTPException(
                        409, "重复进货单号（同一供应商已有此单号）。"
                        "管理员可填原因后强制入库。")
                c.execute(
                    "INSERT INTO purchase_audit_log(purchase_id,draft_id,"
                    "occurred_at,username,action,details) VALUES(?,?,?,?,?,?)",
                    (dup["id"], draft_id, now_iso(), user["username"],
                     "duplicate_invoice_override",
                     "override reason: " + reason))
        calc = sum(ln["line_subtotal_cents"] for ln in lines) \
            - d["discount_cents"] + d["tax_cents"] \
            + d["delivery_fee_cents"] + d["other_fee_cents"]
        total = d["invoice_total_cents"] if d["invoice_total_cents"] is not None else calc
        purchase_no = (
            f"PO-{_next_seq(c, 'purchases:PO-', 'purchases', 'purchase_no', 'PO-'):04d}")
        cur = c.execute(
            "INSERT INTO purchases(supplier_id,invoice_no,fees_cents,"
            "total_cents,cashier,created_at,purchase_no,invoice_date,"
            "discount_cents,tax_cents,delivery_fee_cents,other_fee_cents,"
            "source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'ocr')",
            (d["supplier_id"], inv,
             d["delivery_fee_cents"] + d["other_fee_cents"], total,
             user["username"], now_iso(), purchase_no, d["invoice_date"],
             d["discount_cents"], d["tax_cents"], d["delivery_fee_cents"],
             d["other_fee_cents"]))
        purchase_id = cur.lastrowid
        move_ref = inv or f"PUR{purchase_id}"
        cost_alerts = []
        for ln in lines:
            p = c.execute("SELECT * FROM products WHERE id=?",
                          (ln["matched_product_id"],)).fetchone()
            if not p or not p["is_active"]:
                raise HTTPException(400, "商品不存在或已下架：" +
                                    (ln["raw_product_name"] or ""))
            conv = ln["conversion_factor"]
            stock_in = ln["quantity"] * conv
            unit_cost = int((Decimal(ln["unit_cost_cents"]) / Decimal(str(conv)))
                            .quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            line_total = int((Decimal(str(stock_in)) * unit_cost)
                             .quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            c.execute(
                "INSERT INTO purchase_items(purchase_id,product_id,name,qty,"
                "cost_cents,line_total_cents,prev_cost_cents,raw_qty,unit,"
                "conversion_factor) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (purchase_id, p["id"], p["name"], stock_in, unit_cost,
                 line_total, p["cost_cents"], ln["quantity"], ln["unit"], conv))
            _al = _cost_alert(p["name"], p["price_cents"],
                              p["cost_cents"], unit_cost)
            if _al:
                cost_alerts.append(_al)
            new_qty = p["stock_qty"] + stock_in
            c.execute("UPDATE products SET stock_qty=?, cost_cents=? WHERE id=?",
                      (new_qty, unit_cost, p["id"]))
            c.execute(
                "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                " VALUES(?,?,?,?,?,?)",
                (p["id"], stock_in, new_qty, "purchase", move_ref, now_iso()))
            alias = (body.get("aliases") or {}).get(str(ln["id"]))
            if alias and d["supplier_id"]:
                c.execute(
                    "INSERT INTO supplier_product_aliases(supplier_id,raw_name,"
                    "normalized_name,product_id,unit,conversion_factor,"
                    "use_count,last_used_at) VALUES(?,?,?,?,?,?,1,?)"
                    " ON CONFLICT(supplier_id,normalized_name) DO UPDATE SET"
                    " product_id=excluded.product_id, unit=excluded.unit,"
                    " conversion_factor=excluded.conversion_factor,"
                    " use_count=supplier_product_aliases.use_count+1,"
                    " last_used_at=excluded.last_used_at",
                    (d["supplier_id"], str(alias.get("raw_name", "")),
                     str(alias.get("normalized_name", "")),
                     p["id"], str(alias.get("unit", ln["unit"])),
                     float(alias.get("conversion_factor", conv) or conv),
                     now_iso()))
        c.execute(
            "INSERT INTO purchase_audit_log(purchase_id,draft_id,occurred_at,"
            "username,action,details) VALUES(?,?,?,?,?,?)",
            (purchase_id, draft_id, now_iso(), user["username"],
             "ocr_purchase_committed",
             f"invoice {inv} total {total}"))
        c.execute(
            "UPDATE purchase_drafts SET status='committed',"
            " committed_purchase_id=?, updated_at=? WHERE id=?",
            (purchase_id, now_iso(), draft_id))
    push_event({"type": "sale"})
    return {"ok": True, "id": purchase_id, "purchase_no": purchase_no,
            "total_cents": total, "cost_alerts": cost_alerts}


@app.get("/api/supplier-aliases")
def list_aliases(authorization: str = Header(default=""),
                 supplier_id: int = 0):
    require_admin(current_user(authorization))
    with db() as c:
        if supplier_id:
            rows = c.execute(
                "SELECT * FROM supplier_product_aliases WHERE supplier_id=?"
                " ORDER BY last_used_at DESC", (supplier_id,)).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM supplier_product_aliases"
                " ORDER BY last_used_at DESC").fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.put("/api/supplier-aliases/{alias_id}")
async def update_alias(alias_id: int, req: Request,
                       authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    conv = float(body.get("conversion_factor", 1) or 1)
    if not math.isfinite(conv) or conv <= 0:
        raise HTTPException(400, "conversion_factor must be > 0")
    with db() as c:
        c.execute(
            "UPDATE supplier_product_aliases SET product_id=?, unit=?,"
            " conversion_factor=? WHERE id=?",
            (_int_or_400(body.get("product_id"), "product_id"),
             str(body.get("unit", "pcs")) or "pcs", conv, alias_id))
    return {"ok": True}


@app.delete("/api/supplier-aliases/{alias_id}")
def delete_alias(alias_id: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        c.execute("DELETE FROM supplier_product_aliases WHERE id=?",
                  (alias_id,))
    return {"ok": True}


@app.get("/api/products/{product_id}/purchase-history")
def purchase_history(product_id: int,
                     authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT pi.qty, pi.cost_cents, pu.created_at, pu.purchase_no"
            " FROM purchase_items pi JOIN purchases pu ON pu.id=pi.purchase_id"
            " WHERE pi.product_id=? AND pu.is_reversed=0"
            " ORDER BY pi.id DESC LIMIT 20", (product_id,)).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


# ------------------------------------------------------------- audit ----
@app.post("/api/audit")
async def write_audit(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    body = await req.json()
    action = str(body.get("action", "")).strip()
    if action not in ("line_discount", "order_discount"):
        raise HTTPException(400, "unknown audit action")
    with db() as c:
        c.execute(
            "INSERT INTO audit_logs(occurred_at,username,role,action,module,"
            "product_id,product_name,context,old_value,new_value,reason)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (now_iso(), user["username"], user["role"], action, "pos",
             body.get("product_id"), body.get("product_name"),
             str(body.get("context", "cart")),
             str(body.get("old_value", "")), str(body.get("new_value", "")),
             str(body.get("reason", ""))))
    return {"ok": True}


@app.get("/api/audit")
def list_audit(authorization: str = Header(default=""),
               today: int = 1, username: str = "",
               limit: int = 50, offset: int = 0):
    require_admin(current_user(authorization))
    sql = "SELECT * FROM audit_logs WHERE 1=1"
    args = []
    if today:
        sql += " AND substr(occurred_at,1,10)=?"
        args.append(today_str())
    if username:
        sql += " AND username=?"
        args.append(username)
    sql += " ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?"
    args += [max(1, min(int(limit), 500)), max(0, int(offset))]
    with db() as c:
        rows = c.execute(sql, args).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


# ------------------------------------------- held orders / customers ----
@app.get("/api/held")
def list_held(authorization: str = Header(default="")):
    user = current_user(authorization)
    with db() as c:
        if user["role"] == "ADMIN":
            rows = c.execute("SELECT * FROM held_orders ORDER BY id").fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM held_orders WHERE cashier=? ORDER BY id",
                (user["username"],)).fetchall()
        thr = c.execute(
            "SELECT value FROM settings WHERE key='hold_timeout_minutes'"
        ).fetchone()
    try:
        timeout_min = int(thr["value"]) if thr and thr["value"] else 30
    except (TypeError, ValueError):
        timeout_min = 30
    cutoff = datetime.now(KL) - timedelta(minutes=timeout_min)
    items = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.pop("payload_json"))
        except Exception:
            d["payload"] = {}
        try:
            held_at = datetime.fromisoformat(d["created_at"])
            d["overdue"] = 1 if held_at < cutoff else 0
        except Exception:
            d["overdue"] = 0
        items.append(d)
    return {"ok": True, "items": items}


@app.post("/api/held")
async def create_held(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    body = await req.json()
    payload = body.get("payload") or {}
    if not payload.get("items"):
        raise HTTPException(400, "empty cart")
    with db() as c:
        hold_no = f"H-{_next_seq(c, 'held:H-', 'held_orders', 'hold_no', 'H-'):04d}"
        cur = c.execute(
            "INSERT INTO held_orders(hold_no,cashier,payload_json,created_at)"
            " VALUES(?,?,?,?)",
            (hold_no, user["username"], json.dumps(payload), now_iso()),
        )
        hid = cur.lastrowid
    push_event({"type": "held"})
    return {"ok": True, "id": hid, "hold_no": hold_no}


@app.delete("/api/held/{held_id}")
def delete_held(held_id: int, authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        c.execute("DELETE FROM held_orders WHERE id=?", (held_id,))
    push_event({"type": "held"})
    return {"ok": True}


@app.post("/api/held/{held_id}/consume")
def consume_held(held_id: int, authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        row = c.execute("SELECT * FROM held_orders WHERE id=?",
                        (held_id,)).fetchone()
        if not row:
            raise HTTPException(404, "挂单不存在（可能已被其他设备取单）")
        c.execute("DELETE FROM held_orders WHERE id=?", (held_id,))
    push_event({"type": "held"})
    d = dict(row)
    try:
        d["payload"] = json.loads(d.pop("payload_json"))
    except Exception:
        d["payload"] = {}
    return {"ok": True, "item": d}


@app.get("/api/customers")
def list_customers(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT cu.*, COALESCE(SUM(CASE WHEN s.method='CREDIT'"
            " AND s.is_void=0 AND s.is_training=0 THEN s.total_cents - s.paid_cents ELSE 0 END),0)"
            " outstanding_cents FROM customers cu"
            " LEFT JOIN sales s ON s.customer_id=cu.id"
            " WHERE cu.is_active=1 GROUP BY cu.id ORDER BY cu.name"
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.post("/api/customers")
async def upsert_customer(req: Request, authorization: str = Header(default="")):
    current_user(authorization)
    body = await req.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required")
    with db() as c:
        if body.get("id"):
            c.execute(
                "UPDATE customers SET name=?,phone=?,note=?,is_active=? WHERE id=?",
                (name, str(body.get("phone", "")), str(body.get("note", "")),
                 1 if body.get("is_active", 1) else 0, int(body["id"])),
            )
            cid = int(body["id"])
        else:
            cur = c.execute(
                "INSERT INTO customers(name,phone,note) VALUES(?,?,?)",
                (name, str(body.get("phone", "")), str(body.get("note", ""))),
            )
            cid = cur.lastrowid
    return {"ok": True, "id": cid}


@app.get("/api/credit")
def list_credit(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT s.*, cu.name customer_name FROM sales s"
            " LEFT JOIN customers cu ON cu.id=s.customer_id"
            " WHERE s.method='CREDIT' AND s.is_void=0 AND s.is_training=0"
            " AND s.total_cents > s.paid_cents ORDER BY s.id"
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.post("/api/credit/{sale_id}/repay")
async def repay_credit(sale_id: int, req: Request,
                       authorization: str = Header(default="")):
    user = current_user(authorization)
    body = await req.json()
    amount = _int_or_400(body.get("amount_cents", 0), "amount_cents")
    if amount <= 0:
        raise HTTPException(400, "amount required")
    with db() as c:
        sale = c.execute("SELECT * FROM sales WHERE id=?", (sale_id,)).fetchone()
        if not sale or sale["method"] != "CREDIT" or sale["is_void"]:
            raise HTTPException(404, "credit sale not found")
        due = sale["total_cents"] - sale["paid_cents"]
        if amount > due:
            raise HTTPException(400, "还款金额超过欠款")
        c.execute("UPDATE sales SET paid_cents=? WHERE id=?",
                  (sale["paid_cents"] + amount, sale_id))
        c.execute(
            "INSERT INTO credit_payments(sale_id,amount_cents,cashier,created_at)"
            " VALUES(?,?,?,?)",
            (sale_id, amount, user["username"], now_iso()),
        )
    return {"ok": True, "remaining_cents": due - amount}


# ------------------------------ suppliers / purchases / reports (P3) ----
@app.get("/api/suppliers")
def list_suppliers(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT * FROM suppliers WHERE is_active=1 ORDER BY name").fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.post("/api/suppliers")
async def upsert_supplier(req: Request, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name required")
    with db() as c:
        if body.get("id"):
            c.execute(
                "UPDATE suppliers SET name=?,phone=?,email=?,note=?,is_active=?"
                " WHERE id=?",
                (name, str(body.get("phone", "")), str(body.get("email", "")),
                 str(body.get("note", "")),
                 1 if body.get("is_active", 1) else 0, int(body["id"])),
            )
            sid = int(body["id"])
        else:
            cur = c.execute(
                "INSERT INTO suppliers(name,phone,email,note) VALUES(?,?,?,?)",
                (name, str(body.get("phone", "")), str(body.get("email", "")),
                 str(body.get("note", ""))),
            )
            sid = cur.lastrowid
    return {"ok": True, "id": sid}


@app.delete("/api/products/{pid}")
def delete_product(pid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        cur = c.execute(
            "UPDATE products SET is_active=0 WHERE id=? AND is_active=1",
            (pid,))
        if not cur.rowcount:
            raise HTTPException(404, "product not found")
    return {"ok": True}


@app.delete("/api/customers/{cid}")
def delete_customer(cid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        cur = c.execute(
            "UPDATE customers SET is_active=0 WHERE id=? AND is_active=1",
            (cid,))
        if not cur.rowcount:
            raise HTTPException(404, "customer not found")
    return {"ok": True}


@app.delete("/api/suppliers/{sid}")
def delete_supplier(sid: int, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        cur = c.execute(
            "UPDATE suppliers SET is_active=0 WHERE id=? AND is_active=1",
            (sid,))
        if not cur.rowcount:
            raise HTTPException(404, "supplier not found")
    return {"ok": True}


def _cost_alert(name, price_cents, old_cost, new_cost):
    """Flag a purchase line whose unit cost jumped vs the previous
    cost: rise >= 10% AND >= 10 sen (the sen floor keeps tiny items
    from crying wolf). Carries the margin squeeze at the current
    selling price so the cashier can decide whether to reprice."""
    if not old_cost or old_cost <= 0 or new_cost <= old_cost:
        return None
    rise = new_cost - old_cost
    pct = rise * 100.0 / old_cost
    if pct < 10 or rise < 10:
        return None

    def margin(cost):
        if not price_cents or price_cents <= 0:
            return None
        return round((price_cents - cost) * 100.0 / price_cents, 1)

    return {"name": name, "price_cents": price_cents or 0,
            "old_cost_cents": old_cost, "new_cost_cents": new_cost,
            "pct": round(pct, 1),
            "old_margin_pct": margin(old_cost),
            "new_margin_pct": margin(new_cost)}


@app.post("/api/purchases")
async def create_purchase(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    body = await req.json()
    items = body.get("items") or []
    if not items:
        raise HTTPException(400, "items required")
    invoice_no = str(body.get("invoice_no", "")).strip()
    supplier_id = body.get("supplier_id")
    def _fee(key):
        v = _int_or_400(body.get(key, 0), key)
        if v < 0:
            raise HTTPException(400, f"{key} must be >= 0")
        return v
    discount_p = _fee("discount_cents")
    tax_p = _fee("tax_cents")
    delivery_p = _fee("delivery_fee_cents")
    other_p = _fee("other_fee_cents")
    if not any(k in body for k in ("discount_cents", "tax_cents",
                                   "delivery_fee_cents", "other_fee_cents")):
        other_p = _fee("fees_cents")  # legacy single-fee callers
    fees = delivery_p + other_p
    with db() as c:
        if invoice_no and supplier_id:
            dup = c.execute(
                "SELECT id FROM purchases WHERE supplier_id=? AND invoice_no=?"
                " AND is_reversed=0",
                (supplier_id, invoice_no),
            ).fetchone()
            if dup:
                raise HTTPException(400, "这个供应商已有相同单号的采购（防重复入账）")
        total = -discount_p + tax_p + delivery_p + other_p
        by_pid = {}
        for it in items:
            p = c.execute("SELECT * FROM products WHERE id=?",
                          (_int_or_400(it.get("product_id"),
                                       "product_id"),)).fetchone()
            if not p:
                raise HTTPException(400, f"product {it.get('product_id')} not found")
            try:
                qty = float(it["qty"])
            except (TypeError, ValueError):
                raise HTTPException(400, "qty must be a number")
            if not math.isfinite(qty) or qty <= 0 or qty > 1000000:
                raise HTTPException(400, "qty out of range")
            cost = _int_or_400(it.get("cost_cents", p["cost_cents"]),
                               "cost_cents")
            if cost < 0:
                raise HTTPException(400, "cost_cents must be >= 0")
            line_total = _line_total(cost, qty)
            total += line_total
            pid = p["id"]
            if pid in by_pid:
                prev = by_pid[pid]
                by_pid[pid] = (prev[0], prev[1] + qty, cost,
                               prev[3] + line_total)
            else:
                by_pid[pid] = (p, qty, cost, line_total)
        lines = list(by_pid.values())
        cost_alerts = [a for a in (
            _cost_alert(p["name"], p["price_cents"], p["cost_cents"], cost)
            for p, _q, cost, _lt in lines) if a]
        if supplier_id is not None:
            sup = c.execute(
                "SELECT id FROM suppliers WHERE id=? AND is_active=1",
                (_int_or_400(supplier_id, "supplier_id"),)).fetchone()
            if not sup:
                raise HTTPException(400, "supplier not found")
        purchase_no = (
            f"PO-{_next_seq(c, 'purchases:PO-', 'purchases', 'purchase_no', 'PO-'):04d}")
        cur = c.execute(
            "INSERT INTO purchases(supplier_id,invoice_no,fees_cents,total_cents,"
            "cashier,created_at,purchase_no,invoice_date,discount_cents,"
            "tax_cents,delivery_fee_cents,other_fee_cents,source)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (supplier_id, invoice_no, fees, total, user["username"], now_iso(),
             purchase_no, str(body.get("invoice_date", ""))[:10],
             discount_p, tax_p, delivery_p, other_p,
             str(body.get("source", "manual"))[:20]),
        )
        purchase_id = cur.lastrowid
        for p, qty, cost, line_total in lines:
            c.execute(
                "INSERT INTO purchase_items(purchase_id,product_id,name,qty,"
                "cost_cents,line_total_cents,prev_cost_cents)"
                " VALUES(?,?,?,?,?,?,?)",
                (purchase_id, p["id"], p["name"], qty, cost, line_total,
                 p["cost_cents"]),
            )
            new_qty = p["stock_qty"] + qty
            c.execute("UPDATE products SET stock_qty=?, cost_cents=? WHERE id=?",
                      (new_qty, cost, p["id"]))
            c.execute(
                "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                " VALUES(?,?,?,?,?,?)",
                (p["id"], qty, new_qty, "purchase",
                 invoice_no or f"PUR{purchase_id}", now_iso()),
            )
    push_event({"type": "sale"})
    return {"ok": True, "id": purchase_id, "purchase_no": purchase_no,
            "total_cents": total, "cost_alerts": cost_alerts}


@app.get("/api/purchases")
def list_purchases(authorization: str = Header(default=""), limit: int = 100):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT pu.*, su.name supplier_name FROM purchases pu"
            " LEFT JOIN suppliers su ON su.id=pu.supplier_id"
            " ORDER BY pu.id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.get("/api/purchases/{purchase_id}")
def get_purchase(purchase_id: int, authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        pur = c.execute(
            "SELECT pu.*, su.name supplier_name FROM purchases pu"
            " LEFT JOIN suppliers su ON su.id=pu.supplier_id WHERE pu.id=?",
            (purchase_id,),
        ).fetchone()
        if not pur:
            raise HTTPException(404, "purchase not found")
        items = c.execute(
            "SELECT * FROM purchase_items WHERE purchase_id=?", (purchase_id,)
        ).fetchall()
        audit = c.execute(
            "SELECT * FROM purchase_audit_log WHERE purchase_id=?"
            " ORDER BY id", (purchase_id,)).fetchall()
    return {"ok": True, "purchase": dict(pur),
            "items": [dict(r) for r in items],
            "audit": [dict(r) for r in audit]}


@app.post("/api/purchases/{purchase_id}/reverse")
async def reverse_purchase(purchase_id: int, req: Request,
                           authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    reason = ""
    notes = ""
    try:
        rbody = await req.json()
        if isinstance(rbody, dict):
            reason = str(rbody.get("reason", ""))[:100]
            notes = str(rbody.get("notes", ""))[:500]
    except Exception:
        pass
    with db() as c:
        pur = c.execute("SELECT * FROM purchases WHERE id=?", (purchase_id,)).fetchone()
        if not pur:
            raise HTTPException(404, "purchase not found")
        if pur["is_reversed"]:
            raise HTTPException(400, "already reversed")
        # Safety plan (original rule): if any product on this purchase has
        # stock moves after the purchase itself, a blind reversal would
        # corrupt the ledger — refuse and ask for manual handling.
        for it in c.execute(
                "SELECT * FROM purchase_items WHERE purchase_id=?",
                (purchase_id,)):
            move_ref = pur["invoice_no"] or f"PUR{purchase_id}"
            last_move = c.execute(
                "SELECT MAX(id) m FROM stock_moves WHERE product_id=?"
                " AND ref=?", (it["product_id"], move_ref)).fetchone()
            if last_move and last_move["m"] is not None:
                later = c.execute(
                    "SELECT COUNT(*) n FROM stock_moves WHERE product_id=?"
                    " AND id>? AND reason<>'purchase_reverse'",
                    (it["product_id"], last_move["m"])).fetchone()["n"]
                if later:
                    pname = c.execute(
                        "SELECT name FROM products WHERE id=?",
                        (it["product_id"],)).fetchone()
                    raise HTTPException(
                        400, "商品「" + (pname["name"] if pname else "?") +
                        "」在此采购后已有库存变动，不能直接撤销，"
                        "请使用库存调整或人工处理")
        c.execute(
            "UPDATE purchases SET is_reversed=1, reversed_at=?,"
            " reversed_by=?, reversal_reason=?, reversal_notes=?"
            " WHERE id=?",
            (now_iso(), user["username"], reason, notes, purchase_id))
        went_negative = []
        for it in c.execute(
                "SELECT * FROM purchase_items WHERE purchase_id=?", (purchase_id,)):
            p = c.execute("SELECT stock_qty, cost_cents, name FROM products"
                          " WHERE id=?", (it["product_id"],)).fetchone()
            if p:
                new_qty = p["stock_qty"] - it["qty"]
                if new_qty < 0:
                    went_negative.append(p["name"])
                c.execute("UPDATE products SET stock_qty=? WHERE id=?",
                          (new_qty, it["product_id"]))
                c.execute(
                    "INSERT INTO stock_moves(product_id,delta,qty_after,reason,ref,created_at)"
                    " VALUES(?,?,?,?,?,?)",
                    (it["product_id"], -it["qty"], new_qty, "purchase_reverse",
                     pur["invoice_no"] or f"PUR{purchase_id}", now_iso()),
                )
                if (it["prev_cost_cents"] is not None
                        and p["cost_cents"] == it["cost_cents"]):
                    c.execute(
                        "UPDATE products SET cost_cents=? WHERE id=?",
                        (it["prev_cost_cents"], it["product_id"]))
    push_event({"type": "sale"})
    return {"ok": True,
            "warning": ("反冲后库存变负数：" + "、".join(went_negative))
                       if went_negative else ""}


@app.post("/api/ocr/invoice")
async def ocr_invoice(req: Request, authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    image_b64 = body.get("image_base64", "")
    if not image_b64:
        raise HTTPException(400, "image_base64 required")
    if not SYNC_TOKEN:
        raise HTTPException(503, "helper token not configured on server")
    try:
        raw = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(400, "image_base64 is not valid base64")
    if len(raw) > 8 * 1024 * 1024:
        raise HTTPException(400, "image too large (max 8MB)")
    try:
        async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
            resp = await client.post(
                f"{HELPER_BASE}/api/v1/ocr/invoice",
                files={"file": ("invoice.jpg", raw)},
                headers={TOKEN_HDR: SYNC_TOKEN, "X-LAN-Sync-" + "Token": SYNC_TOKEN},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "helper service unreachable")
    if resp.status_code != 200:
        raise HTTPException(502, f"OCR failed ({resp.status_code})")
    return resp.json()


@app.get("/api/einvoice-status")
def einvoice_status(authorization: str = Header(default=""),
                    environment: str = "production"):
    current_user(authorization)
    env = environment if environment in ("production", "sandbox") \
        else "production"
    with db() as c:
        rows = c.execute(
            "SELECT s.id, s.receipt_no, s.total_cents, s.is_void,"
            " COALESCE(e.status,'pending') status, e.updated_at"
            " FROM sales s LEFT JOIN einvoice_status e"
            " ON e.sale_id=s.id AND e.environment=?"
            " ORDER BY s.id DESC LIMIT 500", (env,)).fetchall()
    return {"ok": True, "environment": env,
            "items": [dict(r) for r in rows]}


@app.get("/api/dashboard")
def dashboard(authorization: str = Header(default="")):
    current_user(authorization)
    day = today_str()
    with db() as c:
        rows = c.execute(
            "SELECT method, deposit_method, total_cents, paid_cents"
            " FROM sales WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10)=?", (day,)).fetchall()
        sales_total = cash = card = duitnow = credit_today = 0
        for r in rows:
            sales_total += r["total_cents"]
            if r["method"] == "CASH":
                cash += r["total_cents"]
            elif r["method"] == "CARD":
                card += r["total_cents"]
            elif r["method"] == "DUITNOW":
                duitnow += r["total_cents"]
            elif r["method"] == "CREDIT":
                credit_today += r["total_cents"] - r["paid_cents"]
                dm = r["deposit_method"]
                if dm == "CASH":
                    cash += r["paid_cents"]
                elif dm == "CARD":
                    card += r["paid_cents"]
                elif dm == "DUITNOW":
                    duitnow += r["paid_cents"]
        credit_open = c.execute(
            "SELECT COALESCE(SUM(total_cents - paid_cents),0) t FROM sales"
            " WHERE is_void=0 AND is_training=0 AND method='CREDIT'"
        ).fetchone()["t"]
    return {"ok": True, "date": day, "sales_total_cents": sales_total,
            "cash_cents": cash, "card_cents": card, "duitnow_cents": duitnow,
            "credit_today_cents": credit_today,
            "credit_open_cents": credit_open, "tickets": len(rows)}


@app.get("/api/reports/summary")
def report_summary(authorization: str = Header(default=""),
                   date_from: str = "", date_to: str = ""):
    current_user(authorization)
    d_from = date_from or today_str()
    d_to = date_to or d_from
    with db() as c:
        agg = c.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total,"
            " COALESCE(SUM(discount_cents),0) discount FROM sales"
            " WHERE is_void=0 AND is_training=0 AND substr(created_at,1,10) BETWEEN ? AND ?",
            (d_from, d_to),
        ).fetchone()
        methods = c.execute(
            "SELECT method, COUNT(*) n, COALESCE(SUM(total_cents),0) total"
            " FROM sales WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY method",
            (d_from, d_to),
        ).fetchall()
        top = c.execute(
            "SELECT si.name, SUM(si.qty) qty, SUM(si.line_total_cents) total"
            " FROM sale_items si JOIN sales s ON s.id=si.sale_id"
            " WHERE s.is_void=0 AND s.is_training=0 AND substr(s.created_at,1,10) BETWEEN ? AND ?"
            " GROUP BY si.name ORDER BY total DESC LIMIT 10",
            (d_from, d_to),
        ).fetchall()
        by_day = c.execute(
            "SELECT substr(created_at,1,10) day, COALESCE(SUM(total_cents),0) total"
            " FROM sales WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY day ORDER BY day",
            (d_from, d_to),
        ).fetchall()
    return {
        "ok": True, "from": d_from, "to": d_to,
        "sales_count": agg["n"], "total_cents": agg["total"],
        "discount_cents": agg["discount"],
        "by_method": [dict(r) for r in methods],
        "top_products": [dict(r) for r in top],
        "by_day": [dict(r) for r in by_day],
    }


@app.get("/api/reports/monthly")
def report_monthly(authorization: str = Header(default=""),
                   month: str = ""):
    """One calendar month, fully organised: totals, per-method split,
    per-day rows, top products, estimated gross profit (from the cost
    snapshot stored on each sale line; older lines without a snapshot
    are reported as uncovered, never guessed), new credit, repayments
    received and purchases for the month."""
    current_user(authorization)
    mon = (month or today_str()[:7]).strip()
    try:
        datetime.strptime(mon, "%Y-%m")
    except ValueError:
        raise HTTPException(400, "month must be YYYY-MM")
    d_from, d_to = mon + "-01", mon + "-31"
    with db() as c:
        agg = c.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total,"
            " COALESCE(SUM(discount_cents),0) discount FROM sales"
            " WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ?",
            (d_from, d_to)).fetchone()
        methods = c.execute(
            "SELECT method, COUNT(*) n, COALESCE(SUM(total_cents),0) total"
            " FROM sales WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY method",
            (d_from, d_to)).fetchall()
        day_rows = c.execute(
            "SELECT substr(created_at,1,10) day, method, COUNT(*) n,"
            " COALESCE(SUM(total_cents),0) total FROM sales"
            " WHERE is_void=0 AND is_training=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ?"
            " GROUP BY day, method ORDER BY day",
            (d_from, d_to)).fetchall()
        top = c.execute(
            "SELECT si.name, SUM(si.qty) qty, SUM(si.line_total_cents) total"
            " FROM sale_items si JOIN sales s ON s.id=si.sale_id"
            " WHERE s.is_void=0 AND s.is_training=0"
            " AND substr(s.created_at,1,10) BETWEEN ? AND ?"
            " GROUP BY si.name ORDER BY total DESC LIMIT 10",
            (d_from, d_to)).fetchall()
        margin = c.execute(
            "SELECT COALESCE(SUM(si.line_total_cents),0) covered,"
            " COALESCE(SUM(si.line_total_cents"
            "   - CAST(ROUND(si.qty * si.unit_cost_cents) AS INTEGER)),0)"
            " profit FROM sale_items si JOIN sales s ON s.id=si.sale_id"
            " WHERE s.is_void=0 AND s.is_training=0"
            " AND si.unit_cost_cents IS NOT NULL"
            " AND substr(s.created_at,1,10) BETWEEN ? AND ?",
            (d_from, d_to)).fetchone()
        credit = c.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) credit_total"
            " FROM sales WHERE is_void=0 AND is_training=0"
            " AND method='CREDIT'"
            " AND substr(created_at,1,10) BETWEEN ? AND ?",
            (d_from, d_to)).fetchone()
        repaid = c.execute(
            "SELECT COALESCE(SUM(amount_cents),0) total FROM credit_payments"
            " WHERE substr(created_at,1,7)=?", (mon,)).fetchone()
        purch = c.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total"
            " FROM purchases WHERE is_reversed=0"
            " AND substr(created_at,1,10) BETWEEN ? AND ?",
            (d_from, d_to)).fetchone()
    days = {}
    for r in day_rows:
        d = days.setdefault(r["day"], {"day": r["day"], "n": 0,
                                       "total_cents": 0, "methods": {}})
        d["n"] += r["n"]
        d["total_cents"] += r["total"]
        d["methods"][r["method"]] = r["total"]
    total = agg["total"]
    return {
        "ok": True, "month": mon,
        "sales_count": agg["n"], "total_cents": total,
        "discount_cents": agg["discount"],
        "avg_cents": (total // agg["n"]) if agg["n"] else 0,
        "by_method": [dict(r) for r in methods],
        "by_day": [days[k] for k in sorted(days)],
        "top_products": [dict(r) for r in top],
        "margin": {"profit_cents": margin["profit"],
                   "covered_cents": margin["covered"]},
        "credit": {"sales_count": credit["n"],
                   "total_cents": credit["credit_total"],
                   "repaid_cents": repaid["total"]},
        "purchases": {"count": purch["n"], "total_cents": purch["total"]},
    }


@app.get("/api/closings")
def list_closings(authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT business_date, closed_by, closed_at FROM daily_closings"
            " ORDER BY business_date DESC LIMIT 60"
        ).fetchall()
    return {"ok": True, "items": [dict(r) for r in rows]}


@app.get("/api/closings/{business_date}")
def get_closing(business_date: str, authorization: str = Header(default="")):
    current_user(authorization)
    with db() as c:
        row = c.execute(
            "SELECT * FROM daily_closings WHERE business_date=?", (business_date,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "closing not found")
    d = dict(row)
    d["payload"] = json.loads(d.pop("payload_json"))
    return {"ok": True, "closing": d}


@app.post("/api/closings")
async def create_closing(req: Request, authorization: str = Header(default="")):
    user = current_user(authorization)
    require_admin(user)
    body = await req.json()
    day = str(body.get("business_date") or today_str())
    counted = body.get("cash_counted_cents")
    if counted is not None:
        counted = _int_or_400(counted, "cash_counted_cents")
    with db() as c:
        methods = c.execute(
            "SELECT method, COUNT(*) n, COALESCE(SUM(total_cents),0) total"
            " FROM sales WHERE is_void=0 AND is_training=0 AND substr(created_at,1,10)=? GROUP BY method",
            (day,),
        ).fetchall()
        grand = c.execute(
            "SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) total FROM sales"
            " WHERE is_void=0 AND is_training=0 AND substr(created_at,1,10)=?",
            (day,),
        ).fetchone()
        cash_sales = next(
            (m["total"] for m in methods if m["method"] == "CASH"), 0)
        # Cash actually received for today's credit sales = what was paid
        # at the till (current paid_cents minus all later repayments on
        # those sales); repayments received today are added separately
        # below, so nothing is counted twice.
        credit_deposits = c.execute(
            "SELECT COALESCE(SUM(s.paid_cents - COALESCE(rp.t,0)),0) t"
            " FROM sales s LEFT JOIN (SELECT sale_id,"
            " SUM(amount_cents) t FROM credit_payments GROUP BY sale_id) rp"
            " ON rp.sale_id=s.id WHERE s.is_void=0 AND s.is_training=0"
            " AND s.method='CREDIT' AND substr(s.created_at,1,10)=?",
            (day,)).fetchone()["t"]
        repayments = c.execute(
            "SELECT COALESCE(SUM(amount_cents),0) t FROM credit_payments"
            " WHERE substr(created_at,1,10)=?", (day,)).fetchone()["t"]
        cash_expected = cash_sales + credit_deposits + repayments
        payload = {
            "business_date": day,
            "sales_count": grand["n"],
            "grand_total_cents": grand["total"],
            "by_method": [dict(m) for m in methods],
            "cash_expected_cents": cash_expected,
            "cash_breakdown_cents": {
                "cash_sales": cash_sales,
                "credit_deposits": credit_deposits,
                "repayments": repayments,
            },
            "cash_counted_cents": counted,
            "cash_diff_cents": (counted - cash_expected)
                if counted is not None else None,
        }
        c.execute(
            "INSERT INTO daily_closings(business_date,payload_json,closed_by,closed_at)"
            " VALUES(?,?,?,?) ON CONFLICT(business_date) DO UPDATE SET"
            " payload_json=excluded.payload_json, closed_by=excluded.closed_by,"
            " closed_at=excluded.closed_at",
            (day, json.dumps(payload), user["username"], now_iso()),
        )
    return {"ok": True, "closing": payload}


@app.post("/api/products/{product_id}/image")
async def set_product_image(product_id: int, req: Request,
                            authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    body = await req.json()
    image_b64 = body.get("image_base64", "")
    with db() as c:
        p = c.execute("SELECT id FROM products WHERE id=?", (product_id,)).fetchone()
        if not p:
            raise HTTPException(404, "product not found")
        if image_b64:
            if len(image_b64) > 11000000:
                raise HTTPException(400, "image too large (max ~8MB)")
            c.execute(
                "INSERT INTO product_images(product_id,image_b64,updated_at)"
                " VALUES(?,?,?) ON CONFLICT(product_id) DO UPDATE SET"
                " image_b64=excluded.image_b64, updated_at=excluded.updated_at",
                (product_id, image_b64, now_iso()),
            )
        else:
            c.execute("DELETE FROM product_images WHERE product_id=?", (product_id,))
    return {"ok": True}


@app.get("/api/products/{product_id}/image")
def get_product_image(product_id: int, token: str = "",
                      authorization: str = Header(default="")):
    # <img> tags cannot send Authorization headers, so a session token in
    # the query string is accepted for this read-only image route.
    current_user(authorization or ("Bearer " + token if token else ""))
    with db() as c:
        row = c.execute(
            "SELECT image_b64 FROM product_images WHERE product_id=?",
            (product_id,),
        ).fetchone()
    if not row or not row["image_b64"]:
        raise HTTPException(404, "no image")
    try:
        raw = base64.b64decode(row["image_b64"])
    except Exception:
        raise HTTPException(500, "image corrupt")
    return Response(content=raw, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=3600"})


# --------------------------------------------------------- exports ----
def _csv_response(filename, header, rows):
    import csv
    import io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(
        content="﻿" + buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/sales.csv")
def export_sales(authorization: str = Header(default=""),
                 date_from: str = "", date_to: str = ""):
    require_admin(current_user(authorization))
    d_from = date_from or "0000-01-01"
    d_to = date_to or "9999-12-31"
    with db() as c:
        rows = c.execute(
            "SELECT s.*, cu.name customer_name FROM sales s"
            " LEFT JOIN customers cu ON cu.id=s.customer_id"
            " WHERE substr(s.created_at,1,10) BETWEEN ? AND ? ORDER BY s.id",
            (d_from, d_to),
        ).fetchall()
    return _csv_response(
        "sales.csv",
        ["receipt_no", "datetime", "cashier", "customer", "method",
         "subtotal_rm", "discount_rm", "total_rm", "paid_rm", "change_rm",
         "bank_ref", "void", "training"],
        [[r["receipt_no"], r["created_at"], r["cashier"],
          r["customer_name"] or "", r["method"],
          f"{r['subtotal_cents']/100:.2f}", f"{r['discount_cents']/100:.2f}",
          f"{r['total_cents']/100:.2f}", f"{r['paid_cents']/100:.2f}",
          f"{r['change_cents']/100:.2f}", r["bank_ref"], r["is_void"],
          r["is_training"]]
         for r in rows],
    )


@app.get("/api/export/products.csv")
def export_products(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    with db() as c:
        rows = c.execute(
            "SELECT p.*, cat.name category_name FROM products p"
            " LEFT JOIN categories cat ON cat.id=p.category_id ORDER BY p.id"
        ).fetchall()
    return _csv_response(
        "products.csv",
        ["id", "name", "sku", "barcode", "category", "price_rm", "cost_rm",
         "stock_qty", "unit", "active"],
        [[r["id"], r["name"], r["sku"], r["barcode"], r["category_name"] or "",
          f"{r['price_cents']/100:.2f}", f"{r['cost_cents']/100:.2f}",
          r["stock_qty"], r["unit"], r["is_active"]] for r in rows],
    )


@app.get("/api/export/payments.csv")
def export_payments(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    if not os.path.exists(PAYMENTS_DB):
        raise HTTPException(404, "payments ledger not available")
    rows = _payments_read(
        "SELECT * FROM payments ORDER BY datetime(recorded_at) ASC, id ASC")
    return _csv_response(
        "payments.csv",
        ["time_kl", "ref_no", "amount_rm"],
        [[_payment_row(r)["time_kl"], r["ref_no"] or "",
          f"{r['amount_cents']/100:.2f}"] for r in rows],
    )


@app.get("/api/export/backup.json")
def export_backup(authorization: str = Header(default="")):
    require_admin(current_user(authorization))
    tables = ["users", "categories", "products", "customers", "suppliers",
              "sales", "sale_items", "stock_moves", "purchases",
              "purchase_items", "held_orders", "daily_closings", "settings",
              "credit_payments"]
    dump = {"exported_at": now_iso(), "tables": {}}
    with db() as c:
        for t in tables:
            rows = c.execute(f"SELECT * FROM {t}").fetchall()
            data = [dict(r) for r in rows]
            if t == "users":
                for u in data:
                    u.pop("pin_salt", None)
                    u.pop("pin_hash", None)
            dump["tables"][t] = data
    return Response(
        content=json.dumps(dump, ensure_ascii=False, indent=1),
        media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="pos2-backup.json"'},
    )


# ------------------------------------------------- payments / live ----
# Payment arrivals are produced by the ai_helper pipeline (PBe email ->
# SQLite ledger). This service reads that ledger read-only, serves the
# records page, and re-broadcasts new arrivals to every connected client
# over one WebSocket, so all devices announce and auto-settle together.
PAYMENTS_DB = os.environ.get(
    "POS2_PAYMENTS_DB", "/www/wwwroot/cnkh_ai_helper/payments.db")
_ws_clients = set()
_event_queue = queue.Queue()


def push_event(evt):
    _event_queue.put(evt)


def _payment_row(r):
    dt = datetime.fromisoformat(r["recorded_at"])
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return {
        "id": r["id"],
        "ref_no": r["ref_no"] or "",
        "amount_cents": r["amount_cents"],
        "time_kl": dt.astimezone(KL).strftime("%Y-%m-%d %H:%M:%S"),
    }


def _payments_read(sql, args=()):
    conn = sqlite3.connect(f"file:{PAYMENTS_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


@app.get("/api/payments")
def list_payments(authorization: str = Header(default=""), limit: int = 300):
    current_user(authorization)
    if not os.path.exists(PAYMENTS_DB):
        return {"ok": True, "available": False, "items": [],
                "summary": {"today_cents": 0, "month_cents": 0,
                            "total_cents": 0, "total_count": 0}}
    rows = _payments_read(
        "SELECT * FROM payments ORDER BY datetime(recorded_at) DESC, id DESC"
        " LIMIT ?", (limit,))
    today = _payments_read(
        "SELECT COALESCE(SUM(amount_cents),0) s FROM payments"
        " WHERE date(datetime(recorded_at,'+8 hours')) = date('now','+8 hours')"
    )[0]["s"]
    month = _payments_read(
        "SELECT COALESCE(SUM(amount_cents),0) s FROM payments"
        " WHERE strftime('%Y-%m', datetime(recorded_at,'+8 hours'))"
        " = strftime('%Y-%m','now','+8 hours')"
    )[0]["s"]
    total = _payments_read(
        "SELECT COALESCE(SUM(amount_cents),0) s, COUNT(*) n FROM payments")[0]
    return {
        "ok": True, "available": True,
        "items": [_payment_row(r) for r in rows],
        "summary": {"today_cents": today, "month_cents": month,
                    "total_cents": total["s"], "total_count": total["n"]},
    }


@app.websocket("/api/ws")
async def ws_live(ws: WebSocket, token: str = ""):
    with db() as c:
        row = c.execute(
            "SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id"
            " WHERE s.token=? AND s.expires_at>? AND u.is_active=1",
            (token, time.time()),
        ).fetchone()
    if not row:
        await ws.close(code=4401)
        return
    await ws.accept()
    _ws_clients.add(ws)
    try:
        while True:
            try:
                await asyncio.wait_for(ws.receive_text(), timeout=30)
            except asyncio.TimeoutError:
                with db() as c:
                    alive = c.execute(
                        "SELECT u.id FROM sessions s JOIN users u"
                        " ON u.id=s.user_id WHERE s." + "token" + "=?"
                        " AND s.expires_at>? AND u.is_active=1",
                        (token, time.time())).fetchone()
                if not alive:
                    await ws.close(code=4401)
                    break
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(ws)


async def _broadcast(evt):
    dead = []
    for client in list(_ws_clients):
        try:
            await client.send_json(evt)
        except Exception:
            dead.append(client)
    for client in dead:
        _ws_clients.discard(client)


async def _poller():
    last_id = 0
    if os.path.exists(PAYMENTS_DB):
        try:
            last_id = _payments_read(
                "SELECT COALESCE(MAX(id),0) m FROM payments")[0]["m"]
        except Exception:
            pass
    while True:
        try:
            while True:
                await _broadcast(_event_queue.get_nowait())
        except queue.Empty:
            pass
        if os.path.exists(PAYMENTS_DB):
            try:
                rows = _payments_read(
                    "SELECT * FROM payments WHERE id>? ORDER BY id", (last_id,))
                for r in rows:
                    last_id = r["id"]
                    await _broadcast({"type": "payment", "payment": _payment_row(r)})
            except Exception:
                pass
        await asyncio.sleep(1)


@app.on_event("startup")
async def _startup():
    asyncio.create_task(_poller())


# --------------------------------------------------------------- site ----
@app.get("/")
def index():
    # The HTML shell must never be cached: it references versioned assets,
    # and a stale shell mixed with a fresh app.js breaks the page wiring.
    return FileResponse(
        os.path.join(SITE_DIR, "index.html"),
        headers={"Cache-Control": "no-cache, must-revalidate"})


class _NoCacheHtmlStatic(StaticFiles):
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        if path.endswith(".html") or path in ("", "/"):
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp


def migrate():
    with db() as c:
        cols = [r[1] for r in c.execute("PRAGMA table_info(sales)")]
        if "is_training" not in cols:
            c.execute("ALTER TABLE sales ADD COLUMN"
                      " is_training INTEGER NOT NULL DEFAULT 0")
        pcols = [r[1] for r in c.execute("PRAGMA table_info(purchase_items)")]
        if "prev_cost_cents" not in pcols:
            c.execute("ALTER TABLE purchase_items ADD COLUMN"
                      " prev_cost_cents INTEGER")
        scols = [r[1] for r in c.execute("PRAGMA table_info(sales)")]
        for col, ddl in (
            ("deposit_method", "deposit_method TEXT"),
            ("customer_name", "customer_name TEXT"),
            ("customer_phone", "customer_phone TEXT"),
            ("rounding_cents", "rounding_cents INTEGER NOT NULL DEFAULT 0"),
            ("item_discount_cents",
             "item_discount_cents INTEGER NOT NULL DEFAULT 0"),
            ("order_discount_cents",
             "order_discount_cents INTEGER NOT NULL DEFAULT 0"),
            ("void_note", "void_note TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in scols:
                c.execute(f"ALTER TABLE sales ADD COLUMN {ddl}")
        icols = [r[1] for r in c.execute("PRAGMA table_info(sale_items)")]
        if "discount_cents" not in icols:
            c.execute("ALTER TABLE sale_items ADD COLUMN"
                      " discount_cents INTEGER NOT NULL DEFAULT 0")
        if "unit_cost_cents" not in icols:
            c.execute("ALTER TABLE sale_items ADD COLUMN"
                      " unit_cost_cents INTEGER")
        prcols = [r[1] for r in c.execute("PRAGMA table_info(products)")]
        if "name_en" not in prcols:
            c.execute("ALTER TABLE products ADD COLUMN"
                      " name_en TEXT NOT NULL DEFAULT ''")
        if "reorder_level" not in prcols:
            c.execute("ALTER TABLE products ADD COLUMN"
                      " reorder_level REAL NOT NULL DEFAULT 0")
        sucols = [r[1] for r in c.execute("PRAGMA table_info(suppliers)")]
        if "email" not in sucols:
            c.execute("ALTER TABLE suppliers ADD COLUMN"
                      " email TEXT NOT NULL DEFAULT ''")
        pucols = [r[1] for r in c.execute("PRAGMA table_info(purchases)")]
        for col, ddl in (
            ("purchase_no", "purchase_no TEXT NOT NULL DEFAULT ''"),
            ("invoice_date", "invoice_date TEXT NOT NULL DEFAULT ''"),
            ("discount_cents", "discount_cents INTEGER NOT NULL DEFAULT 0"),
            ("tax_cents", "tax_cents INTEGER NOT NULL DEFAULT 0"),
            ("delivery_fee_cents",
             "delivery_fee_cents INTEGER NOT NULL DEFAULT 0"),
            ("other_fee_cents", "other_fee_cents INTEGER NOT NULL DEFAULT 0"),
            ("source", "source TEXT NOT NULL DEFAULT 'manual'"),
            ("reversed_at", "reversed_at TEXT"),
            ("reversed_by", "reversed_by TEXT"),
            ("reversal_reason", "reversal_reason TEXT NOT NULL DEFAULT ''"),
            ("reversal_notes", "reversal_notes TEXT NOT NULL DEFAULT ''"),
        ):
            if col not in pucols:
                c.execute(f"ALTER TABLE purchases ADD COLUMN {ddl}")
        c.execute("""CREATE TABLE IF NOT EXISTS audit_logs(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            occurred_at TEXT NOT NULL,
            username TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            module TEXT NOT NULL DEFAULT 'pos',
            product_id INTEGER,
            product_name TEXT,
            context TEXT NOT NULL DEFAULT '',
            old_value TEXT NOT NULL DEFAULT '',
            new_value TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '')""")
        c.execute("""CREATE TABLE IF NOT EXISTS barcode_queue(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            barcode TEXT NOT NULL,
            product_name TEXT NOT NULL,
            sku TEXT NOT NULL DEFAULT '',
            price_cents INTEGER NOT NULL DEFAULT 0,
            copies INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS purchase_drafts(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER,
            supplier_name TEXT NOT NULL DEFAULT '',
            invoice_no TEXT NOT NULL DEFAULT '',
            invoice_date TEXT NOT NULL DEFAULT '',
            ocr_raw_text TEXT NOT NULL DEFAULT '',
            discount_cents INTEGER NOT NULL DEFAULT 0,
            tax_cents INTEGER NOT NULL DEFAULT 0,
            delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
            other_fee_cents INTEGER NOT NULL DEFAULT 0,
            invoice_total_cents INTEGER,
            status TEXT NOT NULL DEFAULT 'draft',
            committed_purchase_id INTEGER,
            created_by TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS purchase_draft_lines(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_id INTEGER NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            raw_text TEXT NOT NULL DEFAULT '',
            raw_product_name TEXT NOT NULL DEFAULT '',
            matched_product_id INTEGER,
            matched_product_name TEXT,
            match_confidence REAL NOT NULL DEFAULT 0,
            quantity REAL NOT NULL DEFAULT 0,
            unit TEXT NOT NULL DEFAULT 'pcs',
            unit_cost_cents INTEGER NOT NULL DEFAULT 0,
            line_subtotal_cents INTEGER NOT NULL DEFAULT 0,
            orig_quantity REAL,
            orig_unit_cost_cents INTEGER,
            orig_line_subtotal_cents INTEGER,
            conversion_factor REAL NOT NULL DEFAULT 1,
            user_modified INTEGER NOT NULL DEFAULT 0)""")
        c.execute("""CREATE TABLE IF NOT EXISTS supplier_product_aliases(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            supplier_id INTEGER NOT NULL,
            raw_name TEXT NOT NULL DEFAULT '',
            normalized_name TEXT NOT NULL,
            product_id INTEGER NOT NULL,
            unit TEXT NOT NULL DEFAULT 'pcs',
            conversion_factor REAL NOT NULL DEFAULT 1,
            use_count INTEGER NOT NULL DEFAULT 1,
            last_used_at TEXT NOT NULL DEFAULT '',
            UNIQUE(supplier_id, normalized_name))""")
        c.execute("""CREATE TABLE IF NOT EXISTS purchase_audit_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            purchase_id INTEGER,
            draft_id INTEGER,
            occurred_at TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            action TEXT NOT NULL,
            field_name TEXT NOT NULL DEFAULT '',
            original_value TEXT NOT NULL DEFAULT '',
            final_value TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '')""")
        picols = [r[1] for r in c.execute("PRAGMA table_info(purchase_items)")]
        for col, ddl in (
            ("raw_qty", "raw_qty REAL"),
            ("unit", "unit TEXT NOT NULL DEFAULT 'pcs'"),
            ("conversion_factor", "conversion_factor REAL NOT NULL DEFAULT 1"),
        ):
            if col not in picols:
                c.execute(f"ALTER TABLE purchase_items ADD COLUMN {ddl}")
        c.execute("""CREATE TABLE IF NOT EXISTS einvoice_status(
            sale_id INTEGER PRIMARY KEY,
            receipt_no TEXT NOT NULL,
            environment TEXT NOT NULL DEFAULT 'production',
            status TEXT NOT NULL DEFAULT 'pending',
            updated_at TEXT NOT NULL)""")


init_db()
migrate()
app.mount("/", _NoCacheHtmlStatic(directory=SITE_DIR, html=True), name="site")
