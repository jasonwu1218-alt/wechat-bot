"""
微信 + Claude AI 机器人 (独立 Python 实现)
===========================================
基于腾讯官方 iLink Bot 协议 (@tencent-weixin/openclaw-weixin)
不需要 OpenClaw 框架，直接调用 iLink HTTP API。

使用方法:
  1. pip install anthropic requests
  2. 设置环境变量 ANTHROPIC_API_KEY
  3. python wechat_claude_bot.py
  4. 终端出现二维码，用微信扫描
  5. 扫码确认后自动开始工作
"""

import base64
import hashlib
import json
import os
import random
import struct
import sys
import time
from pathlib import Path
from typing import Optional

import requests
from anthropic import Anthropic

# ─── 常量 (从 @tencent-weixin/openclaw-weixin 源码提取) ───

BASE_URL = "https://ilinkai.weixin.qq.com"
ILINK_APP_ID = "bot"
BOT_TYPE = "3"
PACKAGE_VERSION = "2.4.4"

# 存储目录
DATA_DIR = Path.home() / ".wechat-claude-bot"
DATA_DIR.mkdir(parents=True, exist_ok=True)
TOKEN_FILE = DATA_DIR / "bot_token.json"
CTX_TOKEN_FILE = DATA_DIR / "context_tokens.json"
SYNC_BUF_FILE = DATA_DIR / "sync_buf.json"


# ─── 工具函数 ───

def build_client_version(version: str) -> int:
    """把版本字符串编码为 uint32 (0x00MMNNPP)"""
    parts = [int(p) for p in version.split(".")]
    major, minor, patch = (parts + [0, 0, 0])[:3]
    return ((major & 0xFF) << 16) | ((minor & 0xFF) << 8) | (patch & 0xFF)


def random_wechat_uin() -> str:
    """生成 X-WECHAT-UIN header"""
    uint32 = struct.pack("!I", random.getrandbits(32))
    return base64.b64encode(str(struct.unpack("!I", uint32)[0]).encode()).decode()


def build_headers(token: Optional[str] = None) -> dict:
    """构建 iLink API 请求头"""
    h = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "X-WECHAT-UIN": random_wechat_uin(),
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": str(build_client_version(PACKAGE_VERSION)),
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def build_base_info() -> dict:
    return {
        "channel_version": PACKAGE_VERSION,
        "bot_agent": "ClaudeBot/1.0",
    }


# ─── 登录流程 ───

def fetch_qrcode() -> dict:
    """获取登录二维码"""
    resp = requests.post(
        f"{BASE_URL}/ilink/bot/get_bot_qrcode?bot_type={BOT_TYPE}",
        headers=build_headers(),
        json={"local_token_list": _load_saved_tokens()},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"\n📱 二维码链接: {data.get('qrcode_img_content', 'N/A')[:80]}...")
    return data


def poll_qrcode_status(qrcode: str, verify_code: Optional[str] = None) -> dict:
    """长轮询二维码扫描状态"""
    endpoint = f"/ilink/bot/get_qrcode_status?qrcode={qrcode}"
    if verify_code:
        endpoint += f"&verify_code={verify_code}"
    try:
        resp = requests.get(
            f"{BASE_URL}{endpoint}",
            headers=build_headers(),
            timeout=40,  # 长轮询
        )
        resp.raise_for_status()
        return resp.json()
    except requests.Timeout:
        return {"status": "wait"}


def _load_saved_tokens() -> list:
    """加载已保存的 bot token 列表"""
    if TOKEN_FILE.exists():
        try:
            data = json.loads(TOKEN_FILE.read_text())
            return [data.get("token")] if data.get("token") else []
        except Exception:
            pass
    return []


def save_token(bot_token: str, account_id: str, base_url: str, user_id: str = ""):
    """保存登录凭据"""
    TOKEN_FILE.write_text(json.dumps({
        "token": bot_token,
        "account_id": account_id,
        "base_url": base_url or BASE_URL,
        "user_id": user_id,
    }, indent=2))


def load_token() -> Optional[dict]:
    """加载已保存的凭据"""
    if TOKEN_FILE.exists():
        try:
            return json.loads(TOKEN_FILE.read_text())
        except Exception:
            pass
    return None


def wechat_login() -> dict:
    """完整的微信登录流程：获取二维码 → 等待扫码确认"""
    print("\n🔑 正在获取登录二维码...")
    qr_data = fetch_qrcode()
    qrcode = qr_data["qrcode"]
    qrcode_url = qr_data.get("qrcode_img_content", "")

    # 在终端显示二维码
    print("\n" + "=" * 50)
    print("📱 请用手机微信扫描以下二维码：")
    print("=" * 50)
    try:
        import qrcode_terminal
        qrcode_terminal.qrcode_terminal.draw(qrcode_url)
    except ImportError:
        pass
    print(f"\n🔗 备用链接: {qrcode_url}")
    print("\n⏳ 等待扫码确认...")

    scanned_printed = False
    refresh_count = 1
    verify_code: Optional[str] = None

    while True:
        status_data = poll_qrcode_status(qrcode, verify_code)
        status = status_data.get("status", "wait")

        if status == "wait":
            if not scanned_printed:
                print(".", end="", flush=True)

        elif status == "scaned":
            if not scanned_printed:
                print("\n✅ 已扫描，正在确认...")
                scanned_printed = True
            verify_code = None  # 清除验证码

        elif status == "need_verifycode":
            code = input("🔢 请输入手机微信上显示的数字: ").strip()
            verify_code = code

        elif status == "expired":
            refresh_count += 1
            if refresh_count > 3:
                raise Exception("二维码多次过期，请稍后重试")
            print(f"\n⏳ 二维码过期，正在刷新... ({refresh_count}/3)")
            qr_data = fetch_qrcode()
            qrcode = qr_data["qrcode"]
            qrcode_url = qr_data.get("qrcode_img_content", "")
            scanned_printed = False
            print(f"🔗 新链接: {qrcode_url}")

        elif status == "verify_code_blocked":
            print("\n⛔ 多次输入错误，正在刷新二维码...")
            refresh_count += 1
            if refresh_count > 3:
                raise Exception("验证码多次错误，请稍后重试")
            qr_data = fetch_qrcode()
            qrcode = qr_data["qrcode"]
            scanned_printed = False

        elif status == "binded_redirect":
            print("\n✅ 已连接过此服务，无需重复连接。")
            existing = load_token()
            if existing:
                return existing
            raise Exception("已绑定但本地无凭据")

        elif status == "scaned_but_redirect":
            redirect_host = status_data.get("redirect_host")
            if redirect_host:
                print(f"\n🔄 重定向到: {redirect_host}")

        elif status == "confirmed":
            bot_token = status_data.get("bot_token")
            account_id = status_data.get("ilink_bot_id")
            base_url_from_server = status_data.get("baseurl") or BASE_URL
            user_id = status_data.get("ilink_user_id", "")

            if not bot_token or not account_id:
                raise Exception(f"登录确认但缺少关键数据: {status_data}")

            save_token(bot_token, account_id, base_url_from_server, user_id)
            print(f"\n✅ 登录成功! Account: {account_id}")
            return {
                "token": bot_token,
                "account_id": account_id,
                "base_url": base_url_from_server,
                "user_id": user_id,
            }

        time.sleep(1)


# ─── 消息收发 ───

def load_context_tokens() -> dict:
    """加载 context_token 缓存"""
    if CTX_TOKEN_FILE.exists():
        try:
            return json.loads(CTX_TOKEN_FILE.read_text())
        except Exception:
            pass
    return {}


def save_context_tokens(tokens: dict):
    """保存 context_token 缓存"""
    CTX_TOKEN_FILE.write_text(json.dumps(tokens))


def get_updates(token: str, base_url: str, get_updates_buf: str = "") -> dict:
    """长轮询获取新消息"""
    try:
        resp = requests.post(
            f"{base_url}/ilink/bot/getupdates",
            headers=build_headers(token),
            json={
                "get_updates_buf": get_updates_buf,
                "base_info": build_base_info(),
            },
            timeout=40,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.Timeout:
        return {"ret": 0, "msgs": [], "get_updates_buf": get_updates_buf}


def send_message(
    token: str,
    base_url: str,
    to_user_id: str,
    text: str,
    context_token: Optional[str] = None,
) -> bool:
    """发送文本消息"""
    item_list = []
    if text:
        item_list.append({
            "type": 1,  # TEXT
            "text_item": {"text": text},
        })

    body = {
        "msg": {
            "to_user_id": to_user_id,
            "message_type": 2,   # BOT
            "message_state": 2,  # FINISH
            "item_list": item_list,
            "context_token": context_token or "",
        },
        "base_info": build_base_info(),
    }

    try:
        resp = requests.post(
            f"{base_url}/ilink/bot/sendmessage",
            headers=build_headers(token),
            json=body,
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        print(f"  ❌ 发送失败: {e}")
        return False


def extract_text_from_message(msg: dict) -> str:
    """从 WeixinMessage 中提取文本内容"""
    item_list = msg.get("item_list", [])
    for item in item_list:
        if item.get("type") == 1:  # TEXT
            return item.get("text_item", {}).get("text", "")
        # 语音转文字
        if item.get("type") == 3:  # VOICE
            voice_text = item.get("voice_item", {}).get("text", "")
            if voice_text:
                return voice_text
    return ""


# ─── Claude 集成 ───

class ClaudeBot:
    """封装 Claude API 的多轮对话管理"""

    def __init__(self, api_key: str):
        self.client = Anthropic(api_key=api_key)
        self.conversations: dict[str, list[dict]] = {}

    def chat(self, user_id: str, message: str) -> str:
        """调用 Claude 获取回复，维护每个用户的对话上下文"""
        if user_id not in self.conversations:
            self.conversations[user_id] = []

        history = self.conversations[user_id]
        history.append({"role": "user", "content": message})

        # 保留最近 30 轮对话
        if len(history) > 60:
            history = history[-60:]

        try:
            response = self.client.messages.create(
                model="claude-opus-4-8",
                max_tokens=1024,
                thinking={"type": "disabled"},  # 必须关掉，否则返回thinking block拿不到text
                system=(
                    "你是一个通过微信与用户聊天的 AI 助手。请遵循以下规则：\n"
                    "1. 用中文回复，语气自然、友好，像真人朋友聊天\n"
                    "2. 回复简洁，控制在 300 字以内\n"
                    "3. 不要使用 Markdown 格式——微信不支持加粗/斜体/代码块\n"
                    "4. 不要使用列表格式（- 或 1.），用自然段落表达\n"
                    "5. 如果遇到不懂的问题，诚实说不知道"
                ),
                messages=history,
            )
            # 安全获取文本：找第一个 text block（跳过 thinking block）
            reply = next((b.text for b in response.content if b.type == "text"), "(无法回复)")
            history.append({"role": "assistant", "content": reply})
            self.conversations[user_id] = history
            return reply

        except Exception as e:
            print(f"  ❌ Claude API 错误: {e}")
            return "抱歉，我暂时无法回复，请稍后再试 🥲"


# ─── 主循环 ───

def main():
    # 检查 API Key
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("❌ 请设置环境变量 ANTHROPIC_API_KEY")
        print("   set ANTHROPIC_API_KEY=sk-ant-api03-你的key")
        sys.exit(1)

    # 登录
    saved = load_token()
    if saved and saved.get("token"):
        print(f"📋 使用已保存的登录凭据 (account: {saved.get('account_id', 'unknown')})")
        token = saved["token"]
        base_url = saved.get("base_url", BASE_URL)
        account_id = saved.get("account_id", "unknown")
    else:
        result = wechat_login()
        token = result["token"]
        base_url = result["base_url"]
        account_id = result["account_id"]

    # 初始化 Claude
    claude = ClaudeBot(api_key)

    # 加载 context_token 缓存
    context_tokens = load_context_tokens()
    get_updates_buf = ""

    print("\n🤖 Claude 微信机器人已启动!")
    print(f"   Account: {account_id}")
    print("   等待消息... (Ctrl+C 停止)\n")

    try:
        while True:
            # 长轮询获取消息
            resp = get_updates(token, base_url, get_updates_buf)

            if resp.get("errcode") == -14:  # session expired
                print("⚠️  会话过期，需要重新登录")
                TOKEN_FILE.unlink(missing_ok=True)
                print("请重新运行程序")
                break

            # 更新 sync buffer
            if resp.get("get_updates_buf"):
                get_updates_buf = resp["get_updates_buf"]

            msgs = resp.get("msgs", [])
            for msg in msgs:
                from_user = msg.get("from_user_id", "")
                ctx_token = msg.get("context_token", "")
                text = extract_text_from_message(msg)

                if not text or not from_user:
                    continue

                # 保存 context_token（必须在回复时回传）
                if ctx_token:
                    context_tokens[from_user] = ctx_token

                print(f"📩 [{from_user[:20]}...] {text[:100]}")

                # 模拟打字延迟
                time.sleep(random.uniform(0.5, 1.5))

                # 调用 Claude
                reply = claude.chat(from_user, text)

                # 发送回复
                ctx = context_tokens.get(from_user)
                success = send_message(token, base_url, from_user, reply, ctx)
                if success:
                    print(f"  ✅ 已回复: {reply[:80]}...")
                else:
                    print(f"  ❌ 回复失败")

            # 每处理一批消息保存一次 context_tokens
            if msgs:
                save_context_tokens(context_tokens)

    except KeyboardInterrupt:
        print("\n\n👋 正在关闭...")
        save_context_tokens(context_tokens)
        print("   context_tokens 已保存")

    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    main()
