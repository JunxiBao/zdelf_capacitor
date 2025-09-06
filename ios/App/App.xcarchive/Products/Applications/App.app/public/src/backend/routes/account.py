import os
from dotenv import load_dotenv
from flask import Blueprint, request, jsonify
import mysql.connector
from mysql.connector import errors as mysql_errors
import uuid
import re
import logging

load_dotenv()

logger = logging.getLogger("app.register")

register_blueprint = Blueprint('register', __name__)

db_config = {
    "host": os.getenv("DB_HOST"),
    "user": os.getenv("DB_USER"),
    "password": os.getenv("DB_PASSWORD"),
    "database": os.getenv("DB_NAME")
}

def _get_conn():
    # Write operation: connection timeout 5s, set single statement max execution 15s, avoid long blocking
    conn = mysql.connector.connect(**db_config, connection_timeout=5, autocommit=False)
    cur = conn.cursor()
    try:
        cur.execute("SET SESSION MAX_EXECUTION_TIME=15000")  # 15s
    finally:
        cur.close()
    return conn

# Supported input:+86***********、86***********、1**********（11）
PHONE_RE = re.compile(r"^\+?\d{6,15}$")

def normalize_cn_phone(raw: str) -> str:
    if not raw:
        return ''
    s = re.sub(r"\s", "", str(raw))
    # Only numbers and optional + are accepted
    if not PHONE_RE.match(s) and not (s.startswith('1') and len(s) == 11 and s.isdigit()):
        return ''
    # Normalize
    digits = re.sub(r"[^0-9]", "", s)
    if s.startswith('+86') or s.startswith('86'):
        # Take last 11 digits
        digits = digits[-11:]
        if len(digits) != 11:
            return ''
        return '+86' + digits
    if s.startswith('1') and len(s) == 11:
        return '+86' + s
    # Other circumstances are not accepted (only mobile phone numbers from Chinese mainland are allowed)
    return ''

@register_blueprint.route('/register', methods=['POST', 'OPTIONS'])
def register():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        data = request.get_json(silent=True) or {}
        logger.info("/register request data=%s", data)

        username = (data.get("username") or '').strip()
        password = (data.get("password") or '')
        age = data.get("age")
        phone_raw = (data.get("phone") or '').strip()
        phone = normalize_cn_phone(phone_raw)

        # Age verification
        try:
            age = int(age)
            if age < 1 or age > 120:
                logger.warning("/register invalid age=%s for username=%s", age, username)
                return jsonify({"success": False, "message": "年龄必须是1-120之间的整数"}), 400
        except (TypeError, ValueError):
            logger.warning("/register invalid age format=%s", age)
            return jsonify({"success": False, "message": "年龄格式不正确"}), 400

        # Mandatory verification
        if not username or not password or age is None or not phone:
            logger.warning("/register missing fields username=%s age=%s phone=%s", username, age, phone)
            return jsonify({"success": False, "message": "缺少用户名、密码、年龄或手机号，或手机号格式不正确（仅支持中国大陆）"}), 400

        conn = _get_conn()
        cursor = conn.cursor(dictionary=True)
        try:
            # If a placeholder account (username=phone and phone_number is empty) has been created in sms/verify before, claim it directly and update it to the official information
            cursor.execute(
                "SELECT user_id FROM users WHERE username=%s AND (phone_number IS NULL OR phone_number='')",
                (phone,)
            )
            placeholder = cursor.fetchone()
            if placeholder:
                cursor.execute(
                    "UPDATE users SET username=%s, password=%s, age=%s, phone_number=%s WHERE user_id=%s",
                    (username, password, age, phone, placeholder['user_id'])
                )
                conn.commit()
                logger.info("/register updated placeholder user_id=%s phone=%s username=%s", placeholder['user_id'], phone, username)
                return jsonify({"success": True, "message": "注册成功（占位账号已更新）"})

            # User name unique
            cursor.execute("SELECT 1 FROM users WHERE username=%s", (username,))
            if cursor.fetchone():
                logger.warning("/register username exists username=%s", username)
                conn.rollback()
                return jsonify({"success": False, "message": "用户名已存在"}), 409

            # Phone number unique
            cursor.execute("SELECT 1 FROM users WHERE phone_number=%s", (phone,))
            if cursor.fetchone():
                logger.warning("/register phone already registered phone=%s", phone)
                conn.rollback()
                return jsonify({"success": False, "message": "该手机号已注册"}), 409

            user_id = str(uuid.uuid4())
            cursor.execute(
                "INSERT INTO users (user_id, username, password, age, phone_number) VALUES (%s, %s, %s, %s, %s)",
                (user_id, username, password, age, phone)
            )
            conn.commit()
            logger.info("/register new user created user_id=%s username=%s phone=%s", user_id, username, phone)
        finally:
            try:
                cursor.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass

        return jsonify({"success": True, "message": "注册成功"})

    except mysql_errors.Error as e:
        # 3024: MAX_EXECUTION_TIME exceeded; 1205: Lock wait timeout; 1213: Deadlock found
        if getattr(e, 'errno', None) in (3024, 1205, 1213):
            logger.warning("/register db timeout/deadlock errno=%s msg=%s", getattr(e, 'errno', None), str(e))
            return jsonify({"success": False, "message": "数据库超时或死锁，请稍后重试"}), 504
        logger.exception("/register db error: %s", e)
        return jsonify({"success": False, "message": "数据库错误", "error": str(e)}), 500
    except Exception as e:
        logger.exception("/register server error: %s", e)
        return jsonify({"success": False, "message": "服务器错误", "error": str(e)}), 500


# 账号注销
@register_blueprint.route('/delete_account', methods=['POST', 'OPTIONS'])
def delete_account():
    if request.method == 'OPTIONS':
        return '', 200
    try:
        data = request.get_json(silent=True) or {}
        username = (data.get("username") or '').strip()
        user_id = (data.get("user_id") or '').strip()
        logger.info("/delete_account request username=%s user_id=%s", username, user_id)

        if not username and not user_id:
            return jsonify({"success": False, "message": "必须提供用户名或用户ID"}), 400

        conn = _get_conn()
        cursor = conn.cursor()
        try:
            if user_id:
                cursor.execute("DELETE FROM users WHERE user_id=%s", (user_id,))
            else:
                cursor.execute("DELETE FROM users WHERE username=%s", (username,))
            if cursor.rowcount == 0:
                conn.rollback()
                return jsonify({"success": False, "message": "未找到对应的账号"}), 404
            conn.commit()
            logger.info("/delete_account success username=%s user_id=%s", username, user_id)
        finally:
            try:
                cursor.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass

        return jsonify({"success": True, "message": "账号已注销"})

    except mysql_errors.Error as e:
        if getattr(e, 'errno', None) in (3024, 1205, 1213):
            logger.warning("/delete_account db timeout/deadlock errno=%s msg=%s", getattr(e, 'errno', None), str(e))
            return jsonify({"success": False, "message": "数据库超时或死锁，请稍后重试"}), 504
        logger.exception("/delete_account db error: %s", e)
        return jsonify({"success": False, "message": "数据库错误", "error": str(e)}), 500
    except Exception as e:
        logger.exception("/delete_account server error: %s", e)
        return jsonify({"success": False, "message": "服务器错误", "error": str(e)}), 500