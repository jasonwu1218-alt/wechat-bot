// Claude AI 助手 — 微信版 (记忆 + 搜索 + 图片 + 行程提醒)
import Anthropic from "@anthropic-ai/sdk";
import { WechatBot } from "wx-clawbot";
import qr from "qrcode-terminal";
import fs from "fs";
import path from "path";
import sharp from "sharp";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) { console.error("请设置 ANTHROPIC_API_KEY"); process.exit(1); }

// ─── 记忆/提醒存储 ───
const MEMORY_DIR = process.env.MEMORY_DIR || "/data/memories";
const SCHEDULE_DIR = path.join(MEMORY_DIR, "schedule");
fs.mkdirSync(SCHEDULE_DIR, { recursive: true });

function handleMemoryTool(input) {
  const { command, path: memPath, file_text, old_str, new_str, insert_line, insert_text } = input;
  const fullPath = path.resolve(MEMORY_DIR, (memPath || "").replace(/^\/+/, ""));
  if (!fullPath.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";
  switch (command) {
    case "view": {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          return fs.readdirSync(fullPath).map(f => {
            const s = fs.statSync(path.join(fullPath, f));
            return `${s.isDirectory()?"/":""}${f} (${s.size}b)`;
          }).join("\n") || "(empty)";
        }
        return fs.readFileSync(fullPath, "utf-8");
      } catch { return "(empty)"; }
    }
    case "create": fs.mkdirSync(path.dirname(fullPath),{recursive:true}); fs.writeFileSync(fullPath,file_text||"","utf-8"); return "created";
    case "str_replace": {
      const c = fs.readFileSync(fullPath,"utf-8");
      const n = c.split(old_str).length-1;
      if (n===0) return "Error: text not found";
      if (n>1) return "Error: matches multiple times";
      fs.writeFileSync(fullPath,c.replace(old_str,new_str),"utf-8"); return "replaced";
    }
    case "insert": {
      const lines=fs.readFileSync(fullPath,"utf-8").split("\n");
      lines.splice(insert_line,0,insert_text);
      fs.writeFileSync(fullPath,lines.join("\n"),"utf-8"); return "inserted";
    }
    case "delete": fs.unlinkSync(fullPath); return "deleted";
    case "rename": {
      const np = path.resolve(MEMORY_DIR,(input.new_path||"").replace(/^\/+/,""));
      if (!np.startsWith(path.resolve(MEMORY_DIR))) return "Error: access denied";
      fs.mkdirSync(path.dirname(np),{recursive:true}); fs.renameSync(fullPath,np); return "renamed";
    }
    default: return `Unknown: ${command}`;
  }
}

// ─── 行程提醒引擎 ───
function loadReminders(userId) {
  const f = path.join(SCHEDULE_DIR, `${userId}.json`);
  try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch { return []; }
}
function saveReminders(userId, reminders) {
  fs.writeFileSync(path.join(SCHEDULE_DIR, `${userId}.json`), JSON.stringify(reminders, null, 2), "utf-8");
}

// Claude 存储提醒的格式指导
const REMINDER_GUIDE = [
  "## 行程提醒（重要！）",
  "当用户提到任何有时间的事情（会议、约会、截止日期、需要做的事），你必须：",
  "1. 先回复确认你记下了",
  "2. 然后用 memory 工具把提醒存入 /schedule/{userId}.json",
  "3. 文件格式是一个 JSON 数组：",
  '[{"time":"2026-06-23T14:00:00+10:00","text":"会议","remindBefore":15,"sent":false}]',
  "- time: ISO8601 格式，带时区（澳洲用 +10:00 或 +11:00 夏令时）",
  "- remindBefore: 提前多少分钟提醒（默认15）",
  "- sent: 必须设为 false",
  "- 多个提醒用数组，记得保留已有的提醒，追加新的",
  "",
  "例如用户说「明天下午3点开会」，你就存成 /schedule/{userId}.json。",
  "如果用户说「取消明天的会议」，你就更新 /schedule/{userId}.json 删除那条。",
].join("\n");

// ─── Claude 调用 ───
const claude = new Anthropic({ apiKey });
const conversations = new Map();

const SYSTEM_PROMPT = [
  "你是 Jason 的超级 AI 助手，通过微信为他提供全方位服务。",
  "",
  "# 🎨 图表生成 (fireworks-tech-graph + diagram-design)",
  "你可以生成生产级 SVG 技术图表，支持以下类型：",
  "- 架构图、数据流图、流程图、序列图、泳道图、ER图、时间线",
  "- 组织架构图、思维导图、象限图、韦恩图、金字塔图",
  "- Agent/RAG架构图、微服务图、多Agent协作图",
  "",
  "## SVG 生成规则：",
  "1. 分类图表类型 → 提取结构(层/节点/边/流) → 规划布局 → 写SVG",
  "2. Architecture: 水平分层(Client→Gateway→Services→Data), viewBox 960x600",
  "3. Flowchart: 上到下, 菱形=决策, 圆角矩形=流程, 节点间距 x:120px y:80px",
  "4. Agent图: Input→Agent Core→Memory→Tools→Output, 用循环箭头表示迭代推理",
  "5. 每条箭头标注数据类型, 主数据流 stroke-width:2.5, 控制流虚线",
  "6. 颜色语义化: 用不同颜色区分不同数据类别",
  "7. 回复时给出完整 SVG 代码, 包裹在 ```svg``` 代码块中",
  "8. 画图前先和用户确认: 类型 + 风格 + 关键元素",
  "",
  "## 设计原则：",
  "- 克制为美: 一个强调色, 两个字体族, 小间距词汇",
  "- 目标密度 4/10: 够技术完备但不拥挤, 超过9个节点拆成两个图",
  "- 每个节点代表独立概念, 每根连线传递信息",
  "",
  "# 🧠 结构化脑暴 (brainstorming)",
  "当用户说「帮我想想」「脑暴」「方案」「怎么选」时, 按以下流程:",
  "1. 探索背景: 先理解现状和目标",
  "2. 逐一提问: 每次只问一个问题, 逐步缩小范围",
  "3. 提出2-3个方案: 每个方案列出优缺点和权衡",
  "4. 给出推荐: 说明推荐理由",
  "5. 也可以用 SWOT / 决策矩阵 / 成本收益分析等框架",
  "原则: 不跳过思考直接给答案, 先问清楚再建议",
  "",
  "# 📝 文档与信息处理 (markitdown)",
  "- 帮用户整理、格式化、转换各类信息",
  "- 将复杂内容组织为清晰的层级结构",
  "- 可以撰写、修改、润色各类文本",
  "",
  "# 🔍 深度搜索",
  "- web_search: 需要实时信息时主动搜索, 多轮搜索直到找到答案",
  "- web_fetch: 搜到相关链接后抓取完整页面内容进行深度分析",
  "- 房产政策、council法规、市场价格、商家信息等必须搜索后回答",
  "- 搜索策略: 先用宽泛关键词, 再根据结果缩小范围",
  "",
  "# 📷 视觉识别",
  "- 识别照片/截图中的文字、物体、场景",
  "- 可以从账单、合同、表格、证件中提取信息并整理",
  "- 收到图片后先描述你看到了什么, 再做分析",
  "",
  "# 🧠 长期记忆与上下文",
  "- 用 memory 工具记录: 用户偏好、项目背景、关键决策、联系信息",
  "- 每次对话开始前查看记忆, 跨对话关联信息",
  "- 用户说过的偏好不要让他重复",
  "",
  "# 🖼️ 图片编辑",
  "当用户发来图片并要求编辑时，回复 JSON 编辑指令：",
  "```json",
  '{"action":"crop|resize|rotate|flip|grayscale|blur|sharpen|tint|text",',
  '"comment":"先说明你要做什么编辑，然后给指令"}',
  "```",
  "- crop: {\"width\":400,\"height\":300,\"left\":0,\"top\":0}",
  "- resize: {\"width\":800,\"height\":600} (等比缩放只填一个)",
  "- rotate: {\"angle\":90} (不填则自动纠偏)",
  "- flip: {} 或 {\"direction\":\"vertical\"}",
  "- grayscale: {}  模糊: {\"blur\":5}  锐化: {\"sharpen\":true}",
  "- tint: {\"color\":\"#ff0000\"}  调色",
  "- text: {\"text\":\"水印文字\",\"x\":10,\"y\":10,\"size\":24,\"color\":\"#fff\"}",
  "先文字说明再给 JSON，让用户知道你要做什么。",
  "",
  REMINDER_GUIDE,
  "",
  "# ⚡ 行为准则",
  "- 中文回复, 深度优先, 不敷衍",
  "- 能画图就主动提议画图, 能搜索就先搜索",
  "- 需要决策时用结构化框架, 信息不足时主动提问",
  "- 微信不支持 Markdown, 用纯文本表达",
  "- 善用分段、缩进、符号让信息清晰可读",
].join("\n");

// ─── 图片编辑引擎 ───
const TMP_DIR = process.env.TMP_DIR || "/tmp/wechat-bot-images";
fs.mkdirSync(TMP_DIR, { recursive: true });

async function editImage(inputBuffer, editJson) {
  let img = sharp(inputBuffer);
  const { action } = editJson;
  switch (action) {
    case "crop":
      img = img.extract({ left: editJson.left||0, top: editJson.top||0, width: editJson.width, height: editJson.height });
      break;
    case "resize":
      img = img.resize({ width: editJson.width, height: editJson.height, fit: "inside", withoutEnlargement: true });
      break;
    case "rotate":
      img = img.rotate(editJson.angle || undefined);
      break;
    case "flip":
      img = editJson.direction === "vertical" ? img.flip() : img.flop();
      break;
    case "grayscale":
      img = img.grayscale();
      break;
    case "blur":
      img = img.blur(editJson.blur || 5);
      break;
    case "sharpen":
      img = img.sharpen();
      break;
    case "tint":
      img = img.tint(editJson.color || "#ff0000");
      break;
    case "text": {
      const svgText = `<svg width="${editJson.width||800}" height="${editJson.height||600}">
        <text x="${editJson.x||10}" y="${editJson.y||30}" font-size="${editJson.size||24}" fill="${editJson.color||'#fff'}">${editJson.text}</text></svg>`;
      img = img.composite([{ input: Buffer.from(svgText), top: 0, left: 0 }]);
      break;
    }
    default: return null;
  }
  return img.jpeg().toBuffer();
}

async function askClaude(userId, text, images=[]) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const messages = conversations.get(userId);

  const content = [];
  for (const img of images) {
    content.push({type:"image",source:{type:"base64",media_type:img.type||"image/jpeg",data:img.data}});
  }
  if (text) content.push({type:"text",text});
  messages.push({role:"user",content:content.length===1&&content[0].type==="text"?text:content});

  // 工具循环
  let resp;
  while (true) {
    resp = await claude.messages.create({
      model: "claude-sonnet-4-6", max_tokens: 4096,
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
        { type: "memory_20250818", name: "memory" },
      ],
      messages,
    });
    const toolBlocks = resp.content.filter(b => b.type === "tool_use");
    if (toolBlocks.length === 0) break;
    messages.push({ role: "assistant", content: resp.content });
    const results = [];
    for (const tb of toolBlocks) {
      if (tb.name === "memory") {
        const r = handleMemoryTool(tb.input);
        console.log(`🧠 memory:${tb.input.command} ${tb.input.path} → ${r.slice(0,50)}`);
        results.push({type:"tool_result",tool_use_id:tb.id,content:r});
      }
    }
    if (results.length > 0) { messages.push({role:"user",content:results}); }
    else break;
  }
  const reply = resp.content.find(b => b.type === "text")?.text ?? "(无法回复)";
  messages.push({role:"assistant",content:reply});
  if (messages.length > 60) messages.splice(0, messages.length - 60);
  return reply;
}

// ─── 后台提醒检查 ───
let botInstance = null;

async function checkReminders() {
  if (!botInstance) return;
  const now = new Date();
  try {
    const files = fs.readdirSync(SCHEDULE_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const userId = f.replace(".json","");
      const reminders = loadReminders(userId);
      let changed = false;
      for (const rem of reminders) {
        if (rem.sent) continue;
        const triggerTime = new Date(new Date(rem.time).getTime() - (rem.remindBefore||15)*60000);
        if (now >= triggerTime) {
          console.log(`⏰ 发送提醒: ${rem.text} → ${userId}`);
          try {
            const resp = await claude.messages.create({
              model: "claude-haiku-4-5", max_tokens: 200,
              thinking: { type: "disabled" },
              system: "你是行程提醒助手。用友好、简洁的中文提醒用户。",
              messages: [{role:"user",content:`请用一句话提醒用户：${rem.text}（时间：${rem.time}）`}],
            });
            const msg = resp.content.find(b=>b.type==="text")?.text || `⏰ 提醒：${rem.text}`;
            // 通过 bot 内部 client 发送
            const client = botInstance.client;
            await client.sendMessage({
              msg: {
                to_user_id: userId,
                message_type: 2,   // BOT
                message_state: 2,  // FINISH
                item_list: [{ type: 1, text_item: { text: msg } }],
              },
            });
            console.log(`✅ 提醒已发送: ${msg.slice(0,60)}`);
          } catch (e) {
            console.error(`❌ 发送提醒失败: ${e.message}`);
          }
          rem.sent = true;
          changed = true;
        }
      }
      if (changed) saveReminders(userId, reminders);
    }
  } catch (e) { console.error("checkReminders error:", e.message); }
}

// ─── 微信 Bot ───
const bot = new WechatBot();
bot.ensureLogin();

bot.on("scan", ({ url }) => {
  console.log(`\n📱 扫码: ${url}\n`);
  try { qr.generate(url, { small: true }, q => console.log(q)); } catch {}
});

bot.on("message", async (msg) => {
  const types = msg.item?.item_list?.map(i=>i.type) || [];
  console.log(`📨 type:${JSON.stringify(types)} text:"${(msg.text||"").slice(0,40)}"`);

  const text = msg.text || "";
  let images = [];
  try {
    const result = await msg.downloadMedia();
    // downloadMedia 返回 {type, buffer} 对象，不是 Buffer
    if (result?.buffer && result.buffer.length > 0) {
      const mime = result.type === "image" ? "image/jpeg" : "application/octet-stream";
      images.push({data:result.buffer.toString("base64"),type:mime});
      console.log(`📷 下载成功 type=${result.type} (${(result.buffer.length/1024).toFixed(0)}KB)`);
    }
  } catch (e) { console.log(`📷 下载失败: ${e.message}`); }

  if (!text && images.length === 0) return;
  console.log(`📩 ${(text||"[图片]").slice(0,100)}`);
  try {
    const reply = await askClaude(msg.from, text, images);

    // 检测是否有图片编辑指令
    const editMatch = reply.match(/\{[\s\S]*"action"\s*:\s*"(crop|resize|rotate|flip|grayscale|blur|sharpen|tint|text)"[\s\S]*\}/);
    if (editMatch && images.length > 0) {
      try {
        const editJson = JSON.parse(editMatch[0]);
        const editedBuffer = await editImage(Buffer.from(images[0].data, "base64"), editJson);
        if (editedBuffer) {
          // 保存到临时文件并发送
          const tmpPath = path.join(TMP_DIR, `edited-${Date.now()}.jpg`);
          fs.writeFileSync(tmpPath, editedBuffer);
          await msg.sendImage(tmpPath);
          console.log(`🖼️ 已发送编辑后图片`);
          // 同时发送文字说明
          const commentOnly = reply.replace(editMatch[0], "").trim();
          if (commentOnly) await msg.sendText(commentOnly);
        }
      } catch (e) {
        console.log(`🖼️ 编辑失败: ${e.message}，发送文字回复`);
        await msg.sendText(reply);
      }
    } else {
      await msg.sendText(reply);
    }
    console.log(`✅ ${reply.slice(0,80)}...`);
  } catch (e) {
    console.error("❌", e.message);
    try { await msg.sendText("抱歉，处理请求时出错了。"); } catch {}
  }
});

bot.on("login", ({ status }) => {
  if (status === "success") {
    console.log("✅ AI 助手已上线 (记忆+搜索+图片+提醒)");
    // 保存 bot 实例用于后台发送提醒
    botInstance = bot;
  }
});
bot.on("logout", () => console.log("⚠️ 会话过期"));
bot.on("error", (e) => console.error("出错:", e.message));

// 启动提醒检查（每60秒）
setInterval(checkReminders, 60000);

console.log("🤖 Claude AI 助手启动中...");
