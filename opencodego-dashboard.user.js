// ==UserScript==
// @name         OpenCodeGo 仪表盘助手
// @namespace    opencodego-dashboard
// @version      0.9.5
// @description  全量抓取并保存用量历史，分析（输入/输出/缓存命中率/费用）与使用历史明细；面板可拖拽调整大小；日志与开关；支持中/英文。
// @author       hiu
// @match        https://opencode.ai/workspace/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // =====================================================================
  // 1. seroval 编解码（与 opencodego-userscript/seroval-core.cjs 保持一致）
  // =====================================================================
  function encodeArgs(args) {
    const refs = new Map();
    let counter = 0;
    let usedRefs = false;
    function enc(v) {
      if (v === null || v === undefined) return { t: 2, s: 0 };
      if (v === true) return { t: 2, s: 2 };
      if (v === false) return { t: 2, s: 3 };
      if (typeof v === "string") return { t: 1, s: v };
      if (typeof v === "number") return { t: 0, s: v };
      if (Array.isArray(v)) {
        if (refs.has(v)) { usedRefs = true; return { t: 4, i: refs.get(v) }; }
        const idx = counter++;
        refs.set(v, idx);
        return { t: 9, i: idx, l: v.length, a: v.map(enc), o: 0 };
      }
      if (typeof v === "object") {
        if (refs.has(v)) { usedRefs = true; return { t: 4, i: refs.get(v) }; }
        const idx = counter++;
        refs.set(v, idx);
        const keys = Object.keys(v);
        return { t: 10, i: idx, p: { k: keys, v: keys.map((k) => enc(v[k])), s: keys.length }, o: 0 };
      }
      throw new Error("unsupported arg type: " + typeof v);
    }
    const tree = enc(Array.from(args));
    return JSON.stringify({ t: tree, f: 31, m: usedRefs ? [1] : [] });
  }

  const NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;

  function tokenize(text) {
    const tokens = [];
    let pos = 0;
    while (pos < text.length) {
      const ch = text[pos];
      if (/\s/.test(ch)) { pos++; continue; }
      if (text.startsWith("$R", pos)) { tokens.push(["ref"]); pos += 2; continue; }
      if ("[]{}:(),=!".includes(ch)) { tokens.push([ch]); pos++; continue; }
      if (ch === '"') {
        const m = /"(?:\\.|[^"\\])*"/y;
        m.lastIndex = pos;
        const mm = m.exec(text);
        if (!mm) throw new Error("bad string at " + pos);
        tokens.push(["str", JSON.parse(mm[0])]);
        pos = mm[0].length + pos;
        continue;
      }
      NUM_RE.lastIndex = pos;
      const nm = NUM_RE.exec(text);
      if (nm && /[0-9]/.test(ch)) {
        const raw = nm[0];
        tokens.push(["num", raw.includes(".") || /[eE]/.test(raw) ? parseFloat(raw) : parseInt(raw, 10)]);
        pos = nm.index + raw.length;
        continue;
      }
      IDENT_RE.lastIndex = pos;
      const im = IDENT_RE.exec(text);
      if (im) {
        tokens.push(["ident", im[0]]);
        pos = im.index + im[0].length;
        continue;
      }
      throw new Error("unexpected char " + JSON.stringify(ch) + " at " + pos);
    }
    return tokens;
  }  class Parser {
    constructor(tokens) { this.toks = tokens; this.i = 0; this.store = new Map(); }
    peek() { return this.toks[this.i]; }
    next() { return this.toks[this.i++]; }
    expect(kind) {
      const t = this.next();
      if (t[0] !== kind) throw new Error("expected " + kind + ", got " + JSON.stringify(t));
      return t;
    }
    parseValue() {
      const t = this.peek();
      if (!t) throw new Error("unexpected end");
      const kind = t[0];
      if (kind === "ref") {
        this.next();
        this.expect("[");
        const idx = this.expect("num")[1];
        this.expect("]");
        const nxt = this.peek();
        if (nxt && nxt[0] === "=") {
          this.next();
          const value = this.parseValue();
          this.store.set(idx, value);
          return value;
        }
        if (this.store.has(idx)) return this.store.get(idx);
        throw new Error("unresolved ref $R[" + idx + "]");
      }
      if (kind === "{") return this.parseObject();
      if (kind === "[") return this.parseArray();
      if (kind === "(") { this.next(); const v = this.parseValue(); this.expect(")"); return v; }
      if (kind === "!") {
        this.next();
        const nxt = this.next();
        if (nxt[1] === 0) return true;
        if (nxt[1] === 1) return false;
        throw new Error("bad ! literal " + JSON.stringify(nxt));
      }
      if (kind === "ident") {
        this.next();
        const v = t[1];
        if (v === "null" || v === "undefined") return null;
        if (v === "true") return true;
        if (v === "false") return false;
        if (v === "void") { this.expect("num"); return null; }
        if (v === "new") {
          const name = this.expect("ident")[1];
          if (name !== "Date") throw new Error("unsupported constructor " + name);
          this.expect("(");
          const s = this.expect("str")[1];
          this.expect(")");
          return s;
        }
        throw new Error("unsupported identifier " + v);
      }
      if (kind === "str" || kind === "num") { this.next(); return t[1]; }
      throw new Error("unexpected token " + JSON.stringify(t));
    }
    parseObject() {
      this.expect("{");
      const obj = {};
      if (this.peek() && this.peek()[0] === "}") { this.next(); return obj; }
      for (;;) {
        const k = this.next();
        if (k[0] !== "str" && k[0] !== "ident") throw new Error("bad object key " + JSON.stringify(k));
        this.expect(":");
        obj[k[1]] = this.parseValue();
        const sep = this.peek();
        if (sep && sep[0] === ",") { this.next(); continue; }
        if (sep && sep[0] === "}") { this.next(); return obj; }
        throw new Error("bad object separator " + JSON.stringify(sep));
      }
    }
    parseArray() {
      this.expect("[");
      const arr = [];
      if (this.peek() && this.peek()[0] === "]") { this.next(); return arr; }
      for (;;) {
        arr.push(this.parseValue());
        const sep = this.peek();
        if (sep && sep[0] === ",") { this.next(); continue; }
        if (sep && sep[0] === "]") { this.next(); return arr; }
        throw new Error("bad array separator " + JSON.stringify(sep));
      }
    }
  }

  function stripWrapper(expr) {
    if (expr.startsWith("(($R=>")) return expr.slice("(($R=>".length);
    let m = /^\(\(self\.\$R=self\.\$R\|\|\{\}\)\[[^\]]*\]=\[\],/.exec(expr);
    if (!m) m = /^\(\(self\.\$R=.*?\]=\[\],/.exec(expr);
    if (m) {
      expr = expr.slice(m[0].length);
      if (expr.startsWith("($R=>")) expr = expr.slice("($R=>".length);
    }
    return expr;
  }

  function decodeStream(body) {
    let text = typeof body === "string" ? body : new TextDecoder().decode(body);
    let chunks;
    if (!text.startsWith(";0x")) {
      chunks = [text];
    } else {
      chunks = [];
      let pos = 0;
      for (;;) {
        const m = /;0x([0-9a-fA-F]{8});/.exec(text.slice(pos));
        if (!m) {
          if (text.slice(pos).trim()) throw new Error("bad chunk framing at " + pos);
          break;
        }
        const size = parseInt(m[1], 16);
        const start = pos + m.index + m[0].length;
        chunks.push(text.slice(start, start + size));
        pos = start + size;
      }
    }
    if (!chunks.length) throw new Error("empty server-function response");
    const parser = new Parser(tokenize(stripWrapper(chunks[0])));
    return parser.parseValue();
  }

  function decodeJsonOrStream(body) {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const s = text.trimStart();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
    }
    return decodeStream(text);
  }  // =====================================================================
  // 2. 配置
  // =====================================================================
  const CONFIG_KEY = "ocgo:config";
  const LOGS_KEY = "ocgo:logs";
  const DEFAULT_CONFIG = {
    enabled: true,
    maxUsagePages: 500,
    lang: "auto", // auto | zh | en
  };
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return Object.assign({}, DEFAULT_CONFIG);
  }
  let config = loadConfig();

  // =====================================================================
  // 2.5 多语言支持（zh / en；默认跟随浏览器语言，可手动切换并持久化）
  // =====================================================================
  const I18N = {
    zh: {
      "lang.auto": "Auto",
      "lang.zh": "中文",
      "lang.en": "English",
      "app.title": "OpenCodeGo 助手",
      "app.close": "关闭面板",
      "app.ready": "就绪",
      "tabs.data": "数据",
      "tabs.history": "使用历史",
      "tabs.log": "日志",
      "ws.notLoaded": "(未登录/未加载)",
      "ws.none": "(无工作区)",
      "ws.refresh": "刷新工作区",
      "ws.refreshed": "✅ 工作区列表已刷新（{n} 个）",
      "ws.refreshFail": "❌ 刷新工作区失败：未登录？请先在 opencode.ai 登录。",
      "usage.fetchAll": "拉取全量用量",
      "usage.clearHistory": "清空历史",
      "usage.stop": "⏹ 停止",
      "range.label": "时间范围",
      "range.from": "从",
      "range.to": "到",
      "range.today": "当天",
      "range.1d": "最近1天",
      "range.7d": "最近7天",
      "range.30d": "最近30天",
      "range.custom": "自定义",
      "range.customLabel": "自定义 {from} ~ {to}",
      "range.all": "全部",
      "analysis.start": "开始分析",
      "analysis.refresh": "拉取最新并分析",
      "analysis.export": "导出分析报告",
      "analysis.placeholder": "选择时间范围后点击“开始分析”（基于历史，不自动发起全量拉取）。",
      "history.placeholder": "选择时间范围后自动展示使用历史（基于历史）。",
      "history.export": "导出历史(CSV)",
      "history.noWorkspace": "请先选择工作区。",
      "history.noData": "暂无用量历史，请先到“数据”页点击“拉取全量用量”。",
      "history.summary": "共 {n} 条（{label}，历史共 {m} 条）",
      "history.limitNote": "仅显示前 {n} 条，共 {m} 条，可缩小时间范围",
      "history.noRecords": "该时间范围内没有记录",
      "history.col.time": "请求时间",
      "history.col.model": "模型",
      "history.col.input": "输入",
      "history.col.reasoning": "推理",
      "history.col.cacheRead": "缓存读",
      "history.col.output": "输出",
      "history.col.cost": "成本",
      "history.col.costUsd": "成本($)",
      "log.copy": "复制日志",
      "log.export": "导出日志",
      "log.clear": "清空日志",
      "log.title": "日志",
      "log.stats": "共{n}条 (E:{e} W:{w} I:{i})",
      "status.noWorkspace": "❌ 请先选择工作区",
      "status.taskBusy": "⚠ 已有任务“{label}”进行中，请先停止或等待完成（同一时间只允许一个查询）",
      "status.stopRequested": "⏹ 已请求停止，正在中断当前请求...",
      "status.fetching": "⏳ 正在分页拉取全量用量（每页50条，最多 {n} 页）...",
      "status.fetchPage": "⏳ 第 {page} 页，已去重累计 {n} 条",
      "status.fetchAdded": "（+新增 {n}）",
      "status.hitHistory": "｜命中历史 {n} 条",
      "status.fetchStopped": "⏹ 已停止：已拉取 {n} 条并保留到历史（标记为不完整）",
      "status.completeNote": "（完整）",
      "status.incompleteNote": "（历史不完整，可能缺更早记录；建议清空历史后完整拉取一次）",
      "status.fetchHitHistory": "✅ 命中历史，提前停止翻页：本次拉到 {n} 条（含历史重合）已与历史合并，写入历史{note}",
      "status.fetchDone": "✅ 全量用量拉取完成：共 {n} 条，已写入历史（完整）",
      "status.fetchFail": "❌ 全量拉取失败：{err}",
      "status.historyCleared": "✅ 历史已清空",
      "status.fetchingLatest": "⏳ 正在拉取最新全量用量...",
      "status.fetchLatestPage": "⏳ 第 {page} 页，已累计 {n} 条",
      "status.analysisStopped": "⏹ 已停止，基于已拉取的 {n} 条分析",
      "status.noHistory": "⚠ 没有历史数据。请先到“数据”页点“拉取全量用量”，或点“拉取最新并分析”。",
      "status.analysisNoHistoryHtml": "还没有用量历史。<br>1) 数据页 → <b>拉取全量用量</b>（一次完整抓取）；<br>2) 或直接点这里右上角 <b>拉取最新并分析</b>。",
      "status.analysisDone": "✅ 分析完成：{label}，区间内 {n} 条（历史共 {m} 条）",
      "status.taskRunning": "⏳ {label} 执行中...",
      "status.taskStopped": "⏹ 已停止：{label}",
      "status.taskFailed": "❌ {label} 失败：{err}（详细错误见日志）",
      "cache.none": "没有用量历史",
      "cache.partial": "历史不完整（仅 {n} 条，来自页面捕获，未做过全量拉取；建议点“拉取最新并分析”）",
      "cache.ok": "持久历史（全量抓取于 {time}，共 {n} 条；无过期，手动清空才消失）",
      "cache.incomplete": "不完整",
      "cache.usageIncompleteTag": "用量[不完整] ",
      "cache.usageState": "{state}{n}条 @ {time}",
      "cache.statePrefix": "历史：",
      "cache.stateNone": "历史：无（拉取后自动记录）",
      "task.fetchAll": "全量用量",
      "task.fetchLatest": "拉取最新用量",
      "task.analyze": "分析",
      "task.analyzeRefresh": "分析(刷新)",
      "metric.requests": "请求数",
      "metric.input": "输入 tokens",
      "metric.output": "输出 tokens",
      "metric.reasoning": "推理 tokens",
      "metric.cacheRead": "缓存读 tokens",
      "metric.cacheWrite": "缓存写 tokens",
      "metric.cost": "总费用",
      "metric.cacheHitRate": "缓存命中率",
      "analysis.formula": "缓存命中率 = 缓存读 / (新输入 + 缓存读)。统计区间：{label}，区间内 {n} 条记录。",
      "analysis.byModel": "按模型",
      "analysis.byDay": "按天",
      "analysis.noRecords": "该时间区间内没有用量记录",
      "analysis.col.model": "模型",
      "analysis.col.requests": "请求",
      "analysis.col.input": "输入",
      "analysis.col.output": "输出",
      "analysis.col.cacheRead": "缓存读",
      "analysis.col.cacheHitRate": "缓存命中率",
      "analysis.col.cost": "费用",
      "analysis.col.day": "日期",
      "log.boot": "OpenCodeGo 助手已启动",
      "log.disabled": "[OpenCodeGo] 总开关已关闭，脚本未注入（可在油猴管理页重新启用）",
      "log.unknownFn": "未知函数: {name}（请更新 FN_IDS）",
      "log.networkError": "网络错误 {name}",
      "log.httpError": "HTTP {status} {name}",
      "log.serverError": "服务端错误 {name}",
      "log.decodeFail": "响应解码失败 {name}",
      "log.rpcOk": "成功 {name}",
      "log.duplicatePage": "第 {page} 页与上一页完全相同，判定分页失效，停止拉取",
      "log.fetchStopped": "全量拉取已停止 {ws}",
      "log.fetchHitHistory": "全量拉取命中历史，提前停止 {ws}",
      "log.fetchDone": "全量用量拉取完成 {ws}",
      "log.fetchFail": "全量拉取失败",
      "log.wsRefreshed": "工作区列表刷新: {n} 个",
      "log.wsRefreshFail": "刷新工作区失败",
      "log.historyExported": "历史已导出",
      "log.analysisDone": "分析完成 {label}",
      "log.reportExported": "分析报告已导出",
      "log.historyRendered": "使用历史已渲染",
      "log.taskStopRequested": "请求停止任务: {label}",
      "log.taskStopped": "已停止: {label}",
      "log.taskIgnored": "忽略并发任务: {label}（当前: {cur}）",
      "log.taskFailed": "{label} 失败",
      "log.captureDecodeFail": "捕获响应解码失败",
      "log.captureRpc": "页面RPC: {name}",
      "log.rowsSuffix": "（{n} 条）",
      "log.captureHook": "fetch hook 已安装（自动捕获 /_server RPC 并入历史）",
      "log.cacheCleared": "历史已清空",
      "log.items": "{n} 项",
      "log.copied": "日志已复制到剪贴板",
      "log.copyFail": "复制失败，请手动复制",
      "log.truncated": "...(截断)",
    },
    en: {
      "lang.auto": "Auto",
      "lang.zh": "中文",
      "lang.en": "English",
      "app.title": "OpenCodeGo Assistant",
      "app.close": "Close panel",
      "app.ready": "Ready",
      "tabs.data": "Data",
      "tabs.history": "Usage History",
      "tabs.log": "Logs",
      "ws.notLoaded": "(Not signed in / not loaded)",
      "ws.none": "(No workspaces)",
      "ws.refresh": "Refresh workspaces",
      "ws.refreshed": "✅ Workspace list refreshed ({n})",
      "ws.refreshFail": "❌ Failed to refresh workspaces: not signed in? Please sign in at opencode.ai.",
      "usage.fetchAll": "Fetch all usage",
      "usage.clearHistory": "Clear history",
      "usage.stop": "⏹ Stop",
      "range.label": "Time range",
      "range.from": "From",
      "range.to": "To",
      "range.today": "Today",
      "range.1d": "Last 1d",
      "range.7d": "Last 7d",
      "range.30d": "Last 30d",
      "range.custom": "Custom",
      "range.customLabel": "Custom {from} ~ {to}",
      "range.all": "All",
      "analysis.start": "Analyze",
      "analysis.refresh": "Fetch latest & analyze",
      "analysis.export": "Export report",
      "analysis.placeholder": "Pick a time range and click “Analyze” (based on history; no automatic full fetch).",
      "history.placeholder": "Usage history will render here after picking a time range (based on history).",
      "history.export": "Export history (CSV)",
      "history.noWorkspace": "Please select a workspace first.",
      "history.noData": "No usage history yet. Go to the Data tab and click “Fetch all usage”.",
      "history.summary": "{n} rows ({label}; {m} rows in history)",
      "history.limitNote": "Showing first {n} of {m} rows; narrow the time range to see more",
      "history.noRecords": "No records in this time range",
      "history.col.time": "Time",
      "history.col.model": "Model",
      "history.col.input": "Input",
      "history.col.reasoning": "Reasoning",
      "history.col.cacheRead": "Cache read",
      "history.col.output": "Output",
      "history.col.cost": "Cost",
      "history.col.costUsd": "Cost($)",
      "log.copy": "Copy logs",
      "log.export": "Export logs",
      "log.clear": "Clear logs",
      "log.title": "Logs",
      "log.stats": "{n} entries (E:{e} W:{w} I:{i})",
      "status.noWorkspace": "❌ Please select a workspace first",
      "status.taskBusy": "⚠ Task “{label}” is already running; stop or wait for it first (only one query at a time)",
      "status.stopRequested": "⏹ Stop requested, cancelling the current request...",
      "status.fetching": "⏳ Fetching full usage page by page (50/page, up to {n} pages)...",
      "status.fetchPage": "⏳ Page {page}: {n} rows after dedup",
      "status.fetchAdded": " (+{n} new)",
      "status.hitHistory": "｜hit history {n} rows",
      "status.fetchStopped": "⏹ Stopped: fetched {n} rows and kept them in history (marked incomplete)",
      "status.completeNote": " (complete)",
      "status.incompleteNote": " (history incomplete; earlier records may be missing. Clear history and do a full fetch once)",
      "status.fetchHitHistory": "✅ Hit history, stopped paging early: this run got {n} rows (incl. duplicates) merged into history{note}",
      "status.fetchDone": "✅ Full usage fetch complete: {n} rows written to history (complete)",
      "status.fetchFail": "❌ Full fetch failed: {err}",
      "status.historyCleared": "✅ History cleared",
      "status.fetchingLatest": "⏳ Fetching the latest full usage...",
      "status.fetchLatestPage": "⏳ Page {page}: {n} rows so far",
      "status.analysisStopped": "⏹ Stopped; analyzing the {n} fetched rows",
      "status.noHistory": "⚠ No history data yet. Go to the Data tab and click “Fetch all usage”, or click “Fetch latest & analyze”.",
      "status.analysisNoHistoryHtml": "No usage history yet.<br>1) Data tab → <b>Fetch all usage</b> (one complete fetch);<br>2) or click <b>Fetch latest & analyze</b> above.",
      "status.analysisDone": "✅ Analysis complete: {label}, {n} rows in range ({m} rows in history)",
      "status.taskRunning": "⏳ Running {label}...",
      "status.taskStopped": "⏹ Stopped: {label}",
      "status.taskFailed": "❌ {label} failed: {err} (see logs for details)",
      "cache.none": "No usage history",
      "cache.partial": "History incomplete ({n} rows from page captures; no full fetch yet; try “Fetch latest & analyze”)",
      "cache.ok": "Persistent history (full fetch at {time}, {n} rows; never expires, cleared only manually)",
      "cache.incomplete": "incomplete",
      "cache.usageIncompleteTag": "Usage[incomplete] ",
      "cache.usageState": "{state}{n} rows @ {time}",
      "cache.statePrefix": "History: ",
      "cache.stateNone": "History: none (records are kept automatically after a fetch)",
      "task.fetchAll": "full usage",
      "task.fetchLatest": "fetch latest usage",
      "task.analyze": "Analyze",
      "task.analyzeRefresh": "Analyze (refresh)",
      "metric.requests": "Requests",
      "metric.input": "Input tokens",
      "metric.output": "Output tokens",
      "metric.reasoning": "Reasoning tokens",
      "metric.cacheRead": "Cache read tokens",
      "metric.cacheWrite": "Cache write tokens",
      "metric.cost": "Total cost",
      "metric.cacheHitRate": "Cache hit rate",
      "analysis.formula": "Cache hit rate = cache read / (new input + cache read). Range: {label}; {n} rows in range.",
      "analysis.byModel": "By model",
      "analysis.byDay": "By day",
      "analysis.noRecords": "No usage records in this range",
      "analysis.col.model": "Model",
      "analysis.col.requests": "Requests",
      "analysis.col.input": "Input",
      "analysis.col.output": "Output",
      "analysis.col.cacheRead": "Cache read",
      "analysis.col.cacheHitRate": "Cache hit rate",
      "analysis.col.cost": "Cost",
      "analysis.col.day": "Date",
      "log.boot": "OpenCodeGo Assistant started",
      "log.disabled": "[OpenCodeGo] Disabled; script not injected (re-enable in the userscript manager)",
      "log.unknownFn": "Unknown function: {name} (update FN_IDS)",
      "log.networkError": "Network error {name}",
      "log.httpError": "HTTP {status} {name}",
      "log.serverError": "Server error {name}",
      "log.decodeFail": "Response decode failed {name}",
      "log.rpcOk": "OK {name}",
      "log.duplicatePage": "Page {page} is identical to the previous page; pagination seems broken, stopping",
      "log.fetchStopped": "Full usage fetch stopped {ws}",
      "log.fetchHitHistory": "Full usage fetch hit history, stopped early {ws}",
      "log.fetchDone": "Full usage fetch complete {ws}",
      "log.fetchFail": "Full usage fetch failed",
      "log.wsRefreshed": "Workspace list refreshed: {n}",
      "log.wsRefreshFail": "Failed to refresh workspaces",
      "log.historyExported": "History exported",
      "log.analysisDone": "Analysis complete {label}",
      "log.reportExported": "Analysis report exported",
      "log.historyRendered": "Usage history rendered",
      "log.taskStopRequested": "Stop requested for task: {label}",
      "log.taskStopped": "Stopped: {label}",
      "log.taskIgnored": "Concurrent task ignored: {label} (current: {cur})",
      "log.taskFailed": "{label} failed",
      "log.captureDecodeFail": "Failed to decode captured response",
      "log.captureRpc": "Page RPC: {name}",
      "log.rowsSuffix": " ({n} rows)",
      "log.captureHook": "fetch hook installed (auto-captures /_server RPC into history)",
      "log.cacheCleared": "History cleared",
      "log.items": "{n} items",
      "log.copied": "Logs copied to clipboard",
      "log.copyFail": "Copy failed; please copy manually",
      "log.truncated": "...(truncated)",
    },
  };

  let langPref = config.lang === "zh" || config.lang === "en" ? config.lang : "auto";
  let lang = langPref === "auto"
    ? (navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en")
    : langPref;

  function t(key, params) {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key;
    if (params) {
      for (const k in params) {
        s = s.split("{" + k + "}").join(String(params[k]));
      }
    }
    return s;
  }
  function saveConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch (e) { /* ignore */ }
  }
  function setLang(l) {
    langPref = l === "zh" || l === "en" ? l : "auto";
    lang = langPref === "auto"
      ? (navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en")
      : langPref;
    config.lang = langPref;
    saveConfig();
    if (!ui) return;
    const panelVisible = !ui.panel.classList.contains("ocgo-hidden");
    const activeEl = document.querySelector("#ocgo-tabs button.ocgo-active");
    const activeTab = activeEl ? activeEl.getAttribute("data-tab") : "data";
    const prevWs = currentWorkspace(); // 切换语言前记住当前工作区
    ui.fab.remove();
    ui.panel.remove();
    ui = null;
    buildUI();
    if (panelVisible) ui.panel.classList.remove("ocgo-hidden");
    populateWorkspaceSelect(ui.ws, prevWs); // 重建后从缓存恢复工作区列表与选中项
    switchTab(activeTab === "history" || activeTab === "log" ? activeTab : "data");
    renderCacheState();
  }

  // =====================================================================
  // 3. 日志系统（持久化做节流，避免全量拉取时频繁写 localStorage）
  // =====================================================================
  const MAX_LOGS = 300;
  const MAX_ENTRY_CHARS = 600;
  let logBuffer = [];
  let logPersistTimer = null;
  try {
    const raw = localStorage.getItem(LOGS_KEY);
    if (raw) logBuffer = JSON.parse(raw);
  } catch (e) { /* ignore */ }

  function ts() { return new Date().toISOString(); }
  function truncate(v) {
    const s = typeof v === "string" ? v : safeJson(v);
    return s.length > MAX_ENTRY_CHARS ? s.slice(0, MAX_ENTRY_CHARS) + t("log.truncated") : s;
  }
  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function persistLogsSoon() {
    if (logPersistTimer) return;
    logPersistTimer = setTimeout(() => {
      logPersistTimer = null;
      try { localStorage.setItem(LOGS_KEY, JSON.stringify(logBuffer)); } catch (e) { /* ignore */ }
    }, 500);
  }

  function log(level, cat, msg, data) {
    const entry = { t: ts(), level, cat, msg: String(msg), data: data === undefined ? null : truncate(data) };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOGS) logBuffer = logBuffer.slice(-MAX_LOGS);
    persistLogsSoon();
    const prefix = "[OpenCodeGo][" + level + "][" + cat + "]";
    if (level === "error") console.error(prefix, entry.msg, data === undefined ? "" : data);
    else if (level === "warn") console.warn(prefix, entry.msg, data === undefined ? "" : data);
    else console.log(prefix, entry.msg, data === undefined ? "" : data);
    renderLogEntry(entry);
    updateLogStats();
  }
  const info = (cat, msg, data) => log("info", cat, msg, data);
  const warn = (cat, msg, data) => log("warn", cat, msg, data);
  const error = (cat, msg, data) => log("error", cat, msg, data);

  function clearLogs() {
    logBuffer = [];
    try { localStorage.removeItem(LOGS_KEY); } catch (e) { /* ignore */ }
    const el = document.getElementById("ocgo-log-list");
    if (el) el.innerHTML = "";
    updateLogStats();
  }

  // =====================================================================
  // 4. IndexedDB 历史存储层
  //    meta = { lastFullFetchAt, lastUpdatedAt, count, complete }
  //    - lastFullFetchAt: 仅"全量分页拉取成功完成/手动停止"时更新
  //    - lastUpdatedAt  : 任何写入（含页面捕获 page0）都更新
  //    - complete       : 全量成功 = true；捕获/单页写入不提升
  // =====================================================================
  const IDB = (() => {
    let dbPromise = null;
    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("ocgo-cache"); // 不指定版本，兼容已存在的更高版本
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }
    async function put(key, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async function get(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const req = tx.objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function del(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    async function keysWithPrefix(prefix) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readonly");
        const req = tx.objectStore("kv").openCursor();
        const keys = [];
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) {
            if (String(cur.key).startsWith(prefix)) keys.push(cur.key);
            cur.continue();
          } else resolve(keys);
        };
        req.onerror = () => reject(req.error);
      });
    }
    return { put, get, del, keysWithPrefix };
  })();

  function usageCacheKey(ws) { return "usage:" + ws; }

  // 内容指纹：请求时间 + 输入/输出/推理/缓存读（含缓存写、模型、费用）完全一致 => 视为同一条记录。
  // 不依赖 id：分页滚动刷新时同一请求可能在不同页出现，指纹去重可稳定合并。
  function usageFingerprint(r) {
    return [
      r.timeCreated, r.inputTokens, r.outputTokens, r.reasoningTokens,
      r.cacheReadTokens, r.cacheWrite5mTokens, r.cacheWrite1hTokens,
      r.model, r.cost,
    ].map((v) => (v === null || v === undefined ? "" : v)).join("|");
  }
  function usageMetaKey(ws) { return "usage:meta:" + ws; }

  // 合并写入：捕获/单页数据也调用；onlyFullFetch 为 true 时才刷新 lastFullFetchAt/complete。
  // 写入串行化：页面捕获（full:false）与全量拉取（full:true）可能并发触发，
  // 若不串行化，后到的捕获写入会基于旧 meta 把 complete/lastFullFetchAt 降级。
  let cacheWriteChain = Promise.resolve();
  async function cacheUsage(ws, records, opts) {
    opts = opts || {};
    if (!Array.isArray(records) || !records.length) return;
    const run = async () => {
      const prevMeta = await IDB.get(usageMetaKey(ws));
      let all = (await IDB.get(usageCacheKey(ws))) || [];
      const byFp = new Map(all.map((r) => [usageFingerprint(r), r]));
      for (const r of records) if (r && usageFingerprint(r)) byFp.set(usageFingerprint(r), r);
      const merged = Array.from(byFp.values());
      await IDB.put(usageCacheKey(ws), merged);
      const meta = {
        lastFullFetchAt: opts.full ? Date.now() : (prevMeta && prevMeta.lastFullFetchAt) || null,
        lastUpdatedAt: Date.now(),
        count: merged.length,
        complete: opts.full ? true : !!(prevMeta && prevMeta.complete),
      };
      await IDB.put(usageMetaKey(ws), meta);
      return { records: merged, meta };
    };
    const p = cacheWriteChain.then(run, run);
    cacheWriteChain = p.then(() => {}, () => {});
    return p;
  }

  async function loadUsage(ws) {
    const meta = await IDB.get(usageMetaKey(ws));
    const records = (await IDB.get(usageCacheKey(ws))) || [];
    return { records, meta };
  }


  async function clearCache() {
    const keys = await IDB.keysWithPrefix("");
    for (const k of keys) await IDB.del(k);
    info("cache", t("log.cacheCleared"), t("log.items", { n: keys.length }));
  }  // =====================================================================
  // 5. 服务端函数 ID（2026-08-10 快照）
  // =====================================================================
  // 只保留实际用到的服务端函数
  const FN_IDS = {
    "workspaces": "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f",
    // usage.list：bfd684bf 是 usage 页面真正的分页函数（参数 [ws, page]）。
    // 注意 6262ba54 是同名的 NewUserSection 查询（只传 [ws]，不能翻页），不要用。
    "usage.list": "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c",
  };
  function buildNameById() {
    const m = {};
    for (const k in FN_IDS) m[FN_IDS[k]] = k;
    return m;
  }
  const FN_NAME_BY_ID = buildNameById();

  // =====================================================================
  // 6. RPC 调用（支持 AbortSignal；成功日志只记摘要，避免日志膨胀）
  // =====================================================================
  let instanceCounter = 0;
  async function rpcCall(name, args, signal) {
    const id = FN_IDS[name];
    if (!id) throw new Error(t("log.unknownFn", { name: name }));
    const encoded = encodeArgs(args);
    const url = location.origin + "/_server";
    const instance = "server-fn:tm" + instanceCounter++;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "X-Server-Id": id,
          "X-Server-Instance": instance,
          "Content-Type": "application/json",
          "Accept": "*/*",
        },
        body: encoded, // seroval 编码的参数数组（与页面一致）
        credentials: "same-origin",
        signal: signal || undefined,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e; // 停止任务，不算错误
      error("rpc", t("log.networkError", { name: name }), { url, message: String(e && e.message || e) });
      throw e;
    }
    if (res.status >= 400) {
      const body = (await res.text()).slice(0, 500);
      error("rpc", t("log.httpError", { status: res.status, name: name }), { url, body });
      throw new Error("HTTP " + res.status + ": " + name + " -> " + body);
    }
    const text = await res.text();
    if (res.headers.get("X-Error")) {
      error("rpc", t("log.serverError", { name: name }), { url, body: text.slice(0, 500) });
      throw new Error("server error: " + text.slice(0, 300));
    }
    let data;
    try {
      data = decodeJsonOrStream(text);
    } catch (e) {
      error("rpc", t("log.decodeFail", { name: name }), { url, message: String(e && e.message || e), body: text.slice(0, 500) });
      throw e;
    }
    // 摘要：数组记条数，对象记 key 列表，避免每条 50 条完整记录撑爆日志
    const summary = Array.isArray(data)
      ? { n: data.length, first: data[0] ? data[0].timeCreated || data[0].id : undefined }
      : (data && typeof data === "object" ? { keys: Object.keys(data).slice(0, 8) } : data);
    info("rpc", t("log.rpcOk", { name: name }), summary);
    return data;
  }  // =====================================================================
  // 7. 任务控制器：同一时间只允许一个任务，支持停止
  // =====================================================================
  const task = {
    running: false,
    stopRequested: false,
    controller: null,
    label: "",
  };

  function setTaskBusy(label) {
    if (task.running) {
      setStatus(t("status.taskBusy", { label: task.label }));
      return false;
    }
    task.running = true;
    task.stopRequested = false;
    task.controller = new AbortController();
    task.label = label;
    showStopButton();
    return true;
  }

  function requestStop() {
    if (!task.running) return;
    task.stopRequested = true;
    if (task.controller) task.controller.abort();
    setStatus(t("status.stopRequested"));
    info("task", t("log.taskStopRequested", { label: task.label }));
  }

  function finishTask() {
    task.running = false;
    task.stopRequested = false;
    task.controller = null;
    task.label = "";
    hideStopButton();
  }

  function showStopButton() {
    if (!ui) return;
    ui.btnStop.style.display = "inline-block"; // 覆盖 CSS 的 display:none
    ui.btnStop.textContent = t("usage.stop") + "(" + task.label + ")";
  }
  function hideStopButton() {
    if (ui && ui.btnStop) ui.btnStop.style.display = "none";
  }

  // =====================================================================
  // 8. 全量用量拉取（可取消 / 防重复页 / 完成时标记 complete）
  // =====================================================================
  async function fetchAllUsage(ws, onProgress) {
    const PAGE_SIZE = 50;
    const maxPages = config.maxUsagePages || 500;
    // 历史数据：用于“遇到重合即停止”的滚动刷新优化
    const prev = await loadUsage(ws);
    const prevComplete = !!(prev.meta && prev.meta.complete && prev.meta.count > 0);
    const prevFps = new Set(prev.records.map((r) => usageFingerprint(r)));
    let page = 0;
    const merged = [];
    const seen = new Set();
    let prevRowsKey = null;
    let stopped = false;
    let stoppedAtHistory = false;
    let reachedEnd = false;
    const addRow = (r) => {
      if (!r) return false;
      const fp = usageFingerprint(r);
      if (!fp || seen.has(fp)) return false;
      seen.add(fp);
      merged.push(r);
      return true;
    };
    for (; page < maxPages; page++) {
      if (task.stopRequested) { stopped = true; break; }
      let rows;
      try {
        rows = await rpcCall("usage.list", [ws, page], task.controller ? task.controller.signal : undefined);
      } catch (e) {
        if (e && e.name === "AbortError") { stopped = true; break; }
        throw e;
      }
      if (!Array.isArray(rows)) break;
      // 防呆：若服务端忽略 page 一直返回同一页，则判定分页失效并停止
      const rowsKey = JSON.stringify(rows.map((r) => r && r.id));
      if (rowsKey === prevRowsKey && rows.length > 0) {
        warn("usage", t("log.duplicatePage", { page: page }), { page: page });
        break;
      }
      prevRowsKey = rowsKey;
      let added = 0;
      let hitHistory = 0;
      for (const r of rows) {
        if (addRow(r)) added++;
        // 本页出现与历史重合的记录 => 更早的页大概率都已在历史中，直接拿历史数据相加
        if (prevFps.has(usageFingerprint(r))) hitHistory++;
      }
      if (onProgress) onProgress({ page: page + 1, fetched: merged.length, added, hitHistory });
      if (rows.length < PAGE_SIZE) { reachedEnd = true; page++; break; }
      // 仅当历史已完整时才“命中历史即停止”；历史不完整时继续翻到底，才能标记完整
      if (hitHistory > 0 && prevComplete) {
        stoppedAtHistory = true;
        break;
      }
    }
    // 手动停止/防呆异常不算完整；历史重合停止时，仅当历史本身完整才标记完整
    const full = !stopped && (reachedEnd || (stoppedAtHistory && prevComplete));
    await cacheUsage(ws, merged, { full });
    if (stopped) {
      info("usage", t("log.fetchStopped", { ws: ws }), { pages: page, total: merged.length });
      return { records: merged, stopped: true, pages: page, stoppedAtHistory: false };
    }
    if (stoppedAtHistory) {
      info("usage", t("log.fetchHitHistory", { ws: ws }), { pages: page, newRows: merged.length, cached: prev.meta.count, complete: full });
      return { records: merged, stopped: false, pages: page, stoppedAtHistory: true, complete: full };
    }
    info("usage", t("log.fetchDone", { ws: ws }), { pages: page, total: merged.length });
    return { records: merged, stopped: false, pages: page, stoppedAtHistory: false, complete: full };
  }

  async function fetchAllUsageWithProgress(ws) {
    if (!ws) { setStatus(t("status.noWorkspace")); return { records: [] }; }
    if (!setTaskBusy(t("task.fetchAll"))) return { records: [] };
    setStatus(t("status.fetching", { n: config.maxUsagePages }));
    try {
      const result = await fetchAllUsage(ws, (p) => {
        let msg = t("status.fetchPage", { page: p.page, n: p.fetched }) + (p.added ? t("status.fetchAdded", { n: p.added }) : "");
        if (p.hitHistory) msg += t("status.hitHistory", { n: p.hitHistory });
        setStatus(msg);
      });
      if (result.stopped) {
        setStatus(t("status.fetchStopped", { n: result.records.length }));
      } else if (result.stoppedAtHistory) {
        const completeNote = result.complete ? t("status.completeNote") : t("status.incompleteNote");
        setStatus(t("status.fetchHitHistory", { n: result.records.length, note: completeNote }));
      } else {
        setStatus(t("status.fetchDone", { n: result.records.length }));
      }
      return result.records;
    } catch (e) {
      error("usage", t("log.fetchFail"), String(e && e.message || e));
      setStatus(t("status.fetchFail", { err: String(e && e.message || e) }));
      throw e;
    } finally {
      finishTask();
      await renderCacheState();
    }
  }  // =====================================================================
  // 9. 页面捕获：写入历史但绝不提升 complete / lastFullFetchAt
  // =====================================================================
  const pageWs = () => {
    const m = location.pathname.match(/\/workspace\/([^/?#]+)/);
    return m ? m[1] : (ui ? ui.ws.value : "") || undefined;
  };

  function installFetchHook() {
    if (!window.fetch || window.__ocgoFetchHooked) return;
    const origFetch = window.fetch;
    window.__ocgoFetchHooked = true;
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      const isServer = url.includes("/_server");
      const p = origFetch.apply(this, arguments);
      if (!isServer) return p;
      p.then((res) => {
        const hdrs = init && init.headers ? init.headers : {};
        const get = (n) => (typeof hdrs.get === "function" ? hdrs.get(n) : hdrs[n]);
        const fnId = get("X-Server-Id") || "";
        const name = fnId && FN_NAME_BY_ID[fnId] ? FN_NAME_BY_ID[fnId] : fnId;
        res.clone().text().then((text) => {
          let data = null;
          try { data = decodeJsonOrStream(text); } catch (e) {
            warn("capture", t("log.captureDecodeFail"), { name, message: String(e && e.message || e), body: text.slice(0, 300) });
            return;
          }
          const n = Array.isArray(data) ? data.length : (data && typeof data === "object" ? Object.keys(data).length : 0);
          info("capture", t("log.captureRpc", { name: name || url }) + (Array.isArray(data) ? t("log.rowsSuffix", { n: n }) : ""));
          const ws = pageWs();
          if (name === "usage.list" && Array.isArray(data)) {
            const byWs = new Map();
            for (const r of data) {
              if (r && r.workspaceID) {
                if (!byWs.has(r.workspaceID)) byWs.set(r.workspaceID, []);
                byWs.get(r.workspaceID).push(r);
              }
            }
            for (const [wid, rows] of byWs) cacheUsage(wid, rows, { full: false }).catch(() => {});
            if (ws) cacheUsage(ws, data, { full: false }).catch(() => {});
          }
        }).catch(() => {});
      }).catch(() => {});
      return p;
    };
    info("capture", t("log.captureHook"));
  }

  // =====================================================================
  // 10. 用量分析
  // =====================================================================
  const MICROCENTS_PER_DOLLAR = 1e8;
  const fmtUsd = (v) => "$" + (num(v) / MICROCENTS_PER_DOLLAR).toFixed(4);
  const fmtNum = (v) => num(v).toLocaleString("en-US");
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));

  function analyzeUsage(records, fromMs, toMs) {
    const inRange = records.filter((r) => {
      const t = new Date(r.timeCreated).getTime();
      return t >= fromMs && t <= toMs;
    });
    const total = { requests: inRange.length, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: 0 };
    const byModel = {};
    const byDay = {};
    for (const r of inRange) {
      total.input += num(r.inputTokens);
      total.output += num(r.outputTokens);
      total.reasoning += num(r.reasoningTokens);
      total.cacheRead += num(r.cacheReadTokens);
      total.cacheWrite5m += num(r.cacheWrite5mTokens);
      total.cacheWrite1h += num(r.cacheWrite1hTokens);
      total.cost += num(r.cost);
      const model = r.model || "unknown";
      if (!byModel[model]) byModel[model] = { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, provider: r.provider || "" };
      const m = byModel[model];
      m.requests++; m.input += num(r.inputTokens); m.output += num(r.outputTokens);
      m.cacheRead += num(r.cacheReadTokens); m.cost += num(r.cost);
      const day = new Date(r.timeCreated).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0 };
      const d = byDay[day];
      d.requests++; d.input += num(r.inputTokens); d.output += num(r.outputTokens);
      d.cacheRead += num(r.cacheReadTokens); d.cost += num(r.cost);
    }
    const cacheHitRate = total.cacheRead + total.input > 0 ? total.cacheRead / (total.cacheRead + total.input) : 0;
    for (const k in byModel) {
      const m = byModel[k];
      m.cacheHitRate = m.cacheRead + m.input > 0 ? m.cacheRead / (m.cacheRead + m.input) : 0;
    }
    return { total, cacheHitRate, byModel, byDay };
  }

  function renderAnalysis(analysis, label) {
    const tot = analysis.total;
    const cards = [
      [t("metric.requests"), fmtNum(tot.requests)],
      [t("metric.input"), fmtNum(tot.input)],
      [t("metric.output"), fmtNum(tot.output)],
      [t("metric.reasoning"), fmtNum(tot.reasoning)],
      [t("metric.cacheRead"), fmtNum(tot.cacheRead)],
      [t("metric.cacheWrite"), fmtNum(tot.cacheWrite5m + tot.cacheWrite1h)],
      [t("metric.cost"), fmtUsd(tot.cost)],
      [t("metric.cacheHitRate"), (analysis.cacheHitRate * 100).toFixed(2) + "%"],
    ];
    let html = "<div class='ocgo-metrics'>" + cards.map(([k, v]) =>
      "<div class='ocgo-metric'><span>" + k + "</span><b>" + v + "</b></div>").join("") + "</div>";
    html += "<p style='color:#8b949e'>" + t("analysis.formula", { label: label, n: fmtNum(tot.requests) }) + "</p>";
    const models = Object.entries(analysis.byModel).sort((a, b) => b[1].cost - a[1].cost);
    if (models.length) {
      html += "<h4>" + t("analysis.byModel") + "</h4><table class='ocgo-tbl'><tr><th>" + t("analysis.col.model") + "</th><th>" + t("analysis.col.requests") + "</th><th>" + t("analysis.col.input") + "</th><th>" + t("analysis.col.output") + "</th><th>" + t("analysis.col.cacheRead") + "</th><th>" + t("analysis.col.cacheHitRate") + "</th><th>" + t("analysis.col.cost") + "</th></tr>";
      for (const [m, v] of models) {
        html += "<tr><td>" + m + "</td><td>" + fmtNum(v.requests) + "</td><td>" + fmtNum(v.input) + "</td><td>" + fmtNum(v.output) +
          "</td><td>" + fmtNum(v.cacheRead) + "</td><td>" + (v.cacheHitRate * 100).toFixed(2) + "%" + "</td><td>" + fmtUsd(v.cost) + "</td></tr>";
      }
      html += "</table>";
    }
    const days = Object.entries(analysis.byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1));
    if (days.length) {
      html += "<h4>" + t("analysis.byDay") + "</h4><table class='ocgo-tbl'><tr><th>" + t("analysis.col.day") + "</th><th>" + t("analysis.col.requests") + "</th><th>" + t("analysis.col.input") + "</th><th>" + t("analysis.col.output") + "</th><th>" + t("analysis.col.cacheRead") + "</th><th>" + t("analysis.col.cost") + "</th></tr>";
      for (const [d, v] of days) {
        html += "<tr><td>" + d + "</td><td>" + fmtNum(v.requests) + "</td><td>" + fmtNum(v.input) + "</td><td>" + fmtNum(v.output) +
          "</td><td>" + fmtNum(v.cacheRead) + "</td><td>" + fmtUsd(v.cost) + "</td></tr>";
      }
      html += "</table>";
    }
    if (tot.requests === 0) html = "<p>" + t("analysis.noRecords") + "</p>" + html;
    return html;
  }  // =====================================================================
  // 11. 面板 UI
  // =====================================================================
  let ui = null;
  let workspaceList = [];
  let workspacesLoaded = false;

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(text) { if (ui) ui.status.textContent = text; }
  function setAnalysis(html) { if (ui) ui.analysis.innerHTML = html; }

  function currentWorkspace() {
    const v = ui && ui.ws.value;
    if (v) return v;
    const m = location.pathname.match(/\/workspace\/([^/?#]+)/);
    return m ? m[1] : undefined;
  }

  function css() {
    return `
#ocgo-fab{position:fixed;right:18px;bottom:18px;z-index:2147483646;width:46px;height:46px;border-radius:50%;
  background:#0d9488;color:#fff;border:none;cursor:pointer;font-size:18px;box-shadow:0 2px 12px rgba(0,0,0,.35);}
#ocgo-panel{position:fixed;right:18px;bottom:74px;z-index:2147483647;width:480px;max-width:calc(100vw - 36px);
  color-scheme:dark;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#111418;color:#e6e6e6;
  border:1px solid #333;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:12px/1.5 -apple-system,"Segoe UI",sans-serif;}
#ocgo-panel.ocgo-hidden{display:none;}
#ocgo-head{padding:8px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
#ocgo-head .ocgo-title{font-weight:700;font-size:13px;margin-right:auto;}
#ocgo-head #ocgo-lang{background:#1c2128;color:#e6e6e6;border:1px solid #333;border-radius:6px;padding:3px 5px;font-size:11px;cursor:pointer;flex:0 0 auto;}
#ocgo-head #ocgo-lang option{background:#1c2128;color:#e6e6e6;}
#ocgo-close{background:#1c2128;color:#8b949e;border:1px solid #3a3f47;border-radius:6px;width:26px;height:26px;font-size:13px;line-height:1;cursor:pointer;flex:0 0 auto;}
#ocgo-close:hover{background:#2a3038;color:#e6e6e6;}
#ocgo-tabs{display:flex;border-bottom:1px solid #333;background:#161b22;}
#ocgo-tabs button{flex:1;background:none;border:none;color:#8b949e;padding:8px 0;cursor:pointer;font-size:12px;border-bottom:2px solid transparent;}
#ocgo-tabs button.ocgo-active{color:#e6e6e6;border-bottom-color:#0d9488;}
#ocgo-body{padding:8px 10px;overflow:auto;flex:1;display:flex;flex-direction:column;gap:8px;}
.ocgo-tab{display:none;flex-direction:column;gap:8px;flex:1;min-height:0;}
.ocgo-tab.ocgo-active{display:flex;}
#ocgo-tab-data,#ocgo-tab-history{overflow:auto;}
#ocgo-tab-data > *,#ocgo-tab-history > *{flex-shrink:0;}
#ocgo-tab-log{overflow:hidden;}
#ocgo-ws-row{display:flex;gap:6px;align-items:center;}
#ocgo-ws{flex:1;background:#1c2128;color:#e6e6e6;border:1px solid #333;border-radius:6px;padding:4px 6px;}
#ocgo-btns{display:flex;flex-wrap:wrap;gap:6px;}
#ocgo-btns button,#ocgo-analyze-btns button{background:#1c2128;color:#e6e6e6;border:1px solid #3a3f47;border-radius:6px;padding:5px 8px;cursor:pointer;}
#ocgo-btns button:hover,#ocgo-analyze-btns button:hover{background:#2a3038;}
#ocgo-btns button.ocgo-primary,#ocgo-analyze-btns button.ocgo-primary{background:#0d9488;border-color:#0d9488;color:#fff;}
#ocgo-btns button.ocgo-stop{background:#d29922;border-color:#d29922;color:#111;display:none;}
#ocgo-status{color:#8b949e;min-height:16px;}
#ocgo-history-state{color:#8b949e;font-size:11px;}
#ocgo-range{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
#ocgo-range select,#ocgo-range input,#ocgo-custom-range input{background:#1c2128;color:#e6e6e6;border:1px solid #333;border-radius:6px;padding:4px 6px;}
#ocgo-custom-range{display:none;gap:6px;align-items:center;flex-wrap:wrap;}
#ocgo-custom-range.ocgo-show{display:flex;}
#ocgo-analysis{background:#0d1117;border:1px solid #333;border-radius:6px;padding:8px;flex:1 1 auto;min-height:80px;max-height:420px;overflow:auto;}
#ocgo-analysis h4{margin:8px 0 4px;color:#58a6ff;}
.ocgo-metrics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;}
.ocgo-metric{flex:1 1 90px;background:#161b22;border:1px solid #333;border-radius:6px;padding:6px;text-align:center;}
.ocgo-metric span{display:block;color:#8b949e;font-size:10px;}
.ocgo-metric b{font-size:13px;}
.ocgo-tbl{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;}
.ocgo-tbl th,.ocgo-tbl td{border:1px solid #2a3038;padding:3px 6px;text-align:right;}
.ocgo-tbl th{background:#161b22;color:#8b949e;}
.ocgo-tbl td:first-child,.ocgo-tbl th:first-child{text-align:left;}
#ocgo-log-wrap{border-top:1px solid #333;display:flex;flex-direction:column;flex:1 1 auto;min-height:120px;}
#ocgo-log-head{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;user-select:none;}
#ocgo-log-list{flex:1 1 150px;min-height:80px;overflow:auto;padding:4px 8px;font:11px/1.45 Consolas,monospace;}
.ocgo-log{display:flex;gap:6px;padding:1px 0;border-bottom:1px dashed #222;word-break:break-all;}
.ocgo-log .ocgo-lv{flex:0 0 42px;font-weight:700;}
.ocgo-log .ocgo-cat{flex:0 0 64px;color:#8b949e;}
.ocgo-log.ocgo-info .ocgo-lv{color:#58a6ff;}
.ocgo-log.ocgo-warn .ocgo-lv{color:#d29922;}
.ocgo-log.ocgo-error .ocgo-lv{color:#f85149;}
#ocgo-stats{color:#8b949e;font-size:11px;}
#ocgo-view-custom{display:none;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}
#ocgo-view-custom.ocgo-show{display:flex;}
#ocgo-panel{min-width:380px;min-height:320px;}
#ocgo-panel .ocgo-rh{position:absolute;z-index:6;}
#ocgo-panel .ocgo-rh-n{top:-3px;left:10px;right:10px;height:6px;cursor:ns-resize;}
#ocgo-panel .ocgo-rh-s{bottom:-3px;left:10px;right:10px;height:6px;cursor:ns-resize;}
#ocgo-panel .ocgo-rh-e{right:-3px;top:10px;bottom:10px;width:6px;cursor:ew-resize;}
#ocgo-panel .ocgo-rh-w{left:-3px;top:10px;bottom:10px;width:6px;cursor:ew-resize;}
#ocgo-panel .ocgo-rh-ne{top:-3px;right:-3px;width:12px;height:12px;cursor:nesw-resize;}
#ocgo-panel .ocgo-rh-nw{top:-3px;left:-3px;width:12px;height:12px;cursor:nwse-resize;}
#ocgo-panel .ocgo-rh-se{bottom:-3px;right:-3px;width:12px;height:12px;cursor:nwse-resize;}
#ocgo-panel .ocgo-rh-sw{bottom:-3px;left:-3px;width:12px;height:12px;cursor:nesw-resize;}
#ocgo-panel, #ocgo-panel *{scrollbar-width:thin;scrollbar-color:#3a3f47 #111418;}
#ocgo-panel ::-webkit-scrollbar{width:10px;height:10px;}
#ocgo-panel ::-webkit-scrollbar-track{background:#111418;}
#ocgo-panel ::-webkit-scrollbar-thumb{background:#3a3f47;border-radius:5px;border:2px solid #111418;}
#ocgo-panel ::-webkit-scrollbar-thumb:hover{background:#4a5058;}
`;
  }

  function injectStyle() {
    if (document.getElementById("ocgo-style")) return;
    const style = document.createElement("style");
    style.id = "ocgo-style";
    style.textContent = css();
    (document.head || document.documentElement).appendChild(style);
  }  // 用缓存的 workspaceList 填充工作区下拉框，并尽量恢复 selectedId 选中项
  function populateWorkspaceSelect(select, selectedId) {
    if (!select) return;
    select.innerHTML = "";
    if (!workspaceList.length) {
      select.appendChild(el("option", { value: "" }, workspacesLoaded ? t("ws.none") : t("ws.notLoaded")));
      return;
    }
    for (const w of workspaceList) {
      const id = typeof w === "string" ? w : w.id;
      const name = typeof w === "string" ? w : (w.name || w.id);
      const opt = el("option", { value: id }, name + " (" + id + ")");
      if (id === selectedId) opt.selected = true;
      select.appendChild(opt);
    }
  }

  async function refreshWorkspaces() {
    try {
      const data = await rpcCall("workspaces", []);
      workspaceList = Array.isArray(data) ? data : [];
      workspacesLoaded = true;
      populateWorkspaceSelect(ui.ws, currentWorkspace());
      info("workspace", t("log.wsRefreshed", { n: workspaceList.length }));
      setStatus(t("ws.refreshed", { n: workspaceList.length }));
    } catch (e) {
      error("workspace", t("log.wsRefreshFail"), String(e && e.message || e));
      setStatus(t("ws.refreshFail"));
    }
  }

  // 历史认定：持久保存，永不过期，只有手动清空才消失。
  // state: "none"（无历史） | "partial"（来自页面捕获，未做过全量拉取） | "ok"（有持久历史）
  async function assessUsageCache(ws) {
    const usage = await loadUsage(ws);
    if (!usage.meta || !usage.records.length) {
      return { state: "none", text: t("cache.none"), meta: usage.meta, usage };
    }
    const meta = usage.meta;
    if (!meta.complete || !meta.lastFullFetchAt) {
      return { state: "partial", text: t("cache.partial", { n: meta.count }), meta, usage };
    }
    return { state: "ok", text: t("cache.ok", { time: fmtTime(meta.lastFullFetchAt), n: meta.count }), meta, usage };
  }
  function fmtTime(ms) { return ms ? fmtTime24(new Date(ms).toISOString()) : "?"; }
  // 24 小时制：yyyy/MM/dd HH:mm:ss
  function fmtTime24(iso) {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  async function renderCacheState() {
    if (!ui) return;
    const ws = currentWorkspace();
    const parts = [];
    if (ws) {
      const a = await assessUsageCache(ws);
      if (a.state !== "none") parts.push(t("cache.usageState", { state: a.state === "ok" ? "" : t("cache.usageIncompleteTag"), n: a.meta.count, time: fmtTime(a.meta.lastUpdatedAt) }));
    }
    ui.cacheState.textContent = parts.length ? t("cache.statePrefix") + parts.join("；") : t("cache.stateNone");
  }

  // =====================================================================
  // 使用历史：近期 API 使用情况和成本（请求时间/模型/用量/成本）
  // =====================================================================
  function historyRange() {
    if (!ui) return { from: 0, to: Date.now(), label: t("range.all") };
    const mode = ui.historyRange.value;
    const now = new Date();
    const end = now.getTime();
    if (mode === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); return { from: d.getTime(), to: end, label: t("range.today") }; }
    if (mode === "1d") return { from: end - 24 * 3600 * 1000, to: end, label: t("range.1d") };
    if (mode === "30d") return { from: end - 30 * 24 * 3600 * 1000, to: end, label: t("range.30d") };
    if (mode === "all") return { from: 0, to: end, label: t("range.all") };
    if (mode === "custom") {
      const from = ui.historyFrom.value ? new Date(ui.historyFrom.value).getTime() : 0;
      const to = ui.historyTo.value ? new Date(ui.historyTo.value).getTime() : end;
      return { from, to, label: t("range.custom") };
    }
    return { from: end - 7 * 24 * 3600 * 1000, to: end, label: t("range.7d") };
  }

  async function renderHistory() {
    if (!ui) return;
    const ws = currentWorkspace();
    if (!ws) { ui.historyTable.innerHTML = "<p>" + t("history.noWorkspace") + "</p>"; ui.historyStatus.textContent = ""; return; }
    const usage = await loadUsage(ws);
    if (!usage.meta || !usage.records.length) {
      ui.historyTable.innerHTML = "<p>" + t("history.noData") + "</p>";
      ui.historyStatus.textContent = "";
      return;
    }
    const range = historyRange();
    const rows = usage.records
      .filter((r) => { const t = new Date(r.timeCreated).getTime(); return t >= range.from && t <= range.to; })
      .sort((a, b) => (a.timeCreated < b.timeCreated ? 1 : -1));
    const LIMIT = 300;
    const shown = rows.slice(0, LIMIT);
    ui.historyStatus.textContent = t("history.summary", { n: rows.length, label: range.label, m: usage.records.length });
    let html = "<table class='ocgo-tbl'><tr><th>" + t("history.col.time") + "</th><th>" + t("history.col.model") + "</th><th>" + t("history.col.input") + "</th><th>" + t("history.col.reasoning") + "</th><th>" + t("history.col.cacheRead") + "</th><th>" + t("history.col.output") + "</th><th>" + t("history.col.cost") + "</th></tr>";
    for (const r of shown) {
      html += "<tr><td>" + fmtTime24(r.timeCreated) + "</td><td>" + (r.model || "-") + "</td><td>" + fmtNum(r.inputTokens) +
        "</td><td>" + fmtNum(r.reasoningTokens) + "</td><td>" + fmtNum(r.cacheReadTokens) + "</td><td>" + fmtNum(r.outputTokens) +
        "</td><td>" + fmtUsd(r.cost) + "</td></tr>";
    }
    html += "</table>";
    if (rows.length > LIMIT) html += "<p style='color:#8b949e'>" + t("history.limitNote", { n: LIMIT, m: rows.length }) + "</p>";
    ui.historyTable.innerHTML = rows.length ? html : "<p>" + t("history.noRecords") + "</p>";
    info("history", t("log.historyRendered"), { range: range.label, rows: rows.length });
  }

  async function exportHistoryCsv() {
    const ws = currentWorkspace();
    if (!ws) return;
    const usage = await loadUsage(ws);
    const range = historyRange();
    const rows = usage.records
      .filter((r) => { const t = new Date(r.timeCreated).getTime(); return t >= range.from && t <= range.to; })
      .sort((a, b) => (a.timeCreated < b.timeCreated ? 1 : -1));
    const esc = (v) => '"' + String(v === null || v === undefined ? "" : v).replace(/"/g, '""') + '"';
    const lines = [[t("history.col.time"), t("history.col.model"), t("history.col.input"), t("history.col.reasoning"), t("history.col.cacheRead"), t("history.col.output"), t("history.col.costUsd")].join(",")];
    for (const r of rows) {
      lines.push([fmtTime24(r.timeCreated), r.model || "", num(r.inputTokens),
        num(r.reasoningTokens), num(r.cacheReadTokens), num(r.outputTokens),
        (num(r.cost) / MICROCENTS_PER_DOLLAR).toFixed(4)].map(esc).join(","));
    }
    downloadText("opencodego-history-" + Date.now() + ".csv", "\uFEFF" + lines.join("\r\n"));
    info("history", t("log.historyExported"), { rows: rows.length, range: range.label });
  }

  let rangeMode = "7d";
  function currentRange() {
    const now = new Date();
    const end = now.getTime();
    if (rangeMode === "today") {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      return { from: d.getTime(), to: end, label: t("range.today") };
    }
    if (rangeMode === "1d") return { from: end - 24 * 3600 * 1000, to: end, label: t("range.1d") };
    if (rangeMode === "30d") return { from: end - 30 * 24 * 3600 * 1000, to: end, label: t("range.30d") };
    if (rangeMode === "all") return { from: 0, to: end, label: t("range.all") };
    if (rangeMode === "custom") {
      const from = ui.customFrom.value ? new Date(ui.customFrom.value).getTime() : end - 7 * 24 * 3600 * 1000;
      const to = ui.customTo.value ? new Date(ui.customTo.value).getTime() : end;
      return { from, to, label: t("range.customLabel", { from: ui.customFrom.value || "?", to: ui.customTo.value || "?" }) };
    }
    return { from: end - 7 * 24 * 3600 * 1000, to: end, label: t("range.7d") };
  }

  // 分析：不自动触发全量拉取（避免误触发大量请求），先明确告诉用户历史状态
  async function runAnalysis(forceRefresh) {
    const ws = currentWorkspace();
    if (!ws) { setStatus(t("status.noWorkspace")); return; }
    let cacheNote = "";
    let cacheStateFlag = "none";
    let usage;
    if (forceRefresh) {
      if (!setTaskBusy(t("task.fetchLatest"))) return;
      setStatus(t("status.fetchingLatest"));
      try {
        const records = await fetchAllUsage(ws, (p) => {
          setStatus(t("status.fetchLatestPage", { page: p.page, n: p.fetched }));
        });
        usage = await loadUsage(ws);
        if (records.stopped) setStatus(t("status.analysisStopped", { n: usage.records.length }));
      } finally {
        finishTask();
      }
    } else {
      const assess = await assessUsageCache(ws);
      usage = assess.usage;
      if (assess.state === "none") {
        setStatus(t("status.noHistory"));
        setAnalysis(t("status.analysisNoHistoryHtml"));
        return;
      }
      cacheNote = assess.text;
      cacheStateFlag = assess.state;
    }
    const range = currentRange();
    const analysis = analyzeUsage(usage.records, range.from, range.to);
    let html = renderAnalysis(analysis, range.label);
    if (cacheNote && cacheStateFlag !== "ok") {
      html = "<p style='color:#d29922'>⚠ " + cacheNote + "</p>" + html;
    }
    setAnalysis(html);
    info("analysis", t("log.analysisDone", { label: range.label }), { range, total: analysis.total, cache: cacheStateFlag });
    setStatus(t("status.analysisDone", { label: range.label, n: analysis.total.requests, m: usage.records.length }));
  }

  // 自定义时间输入随预设范围联动（当天/1d/7d/30d/all）
  function toLocalInput(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function syncRangeInputs(mode, fromEl, toEl) {
    const now = new Date();
    const end = now.getTime();
    let from;
    if (mode === "today") { const d = new Date(now); d.setHours(0, 0, 0, 0); from = d.getTime(); }
    else if (mode === "1d") from = end - 24 * 3600 * 1000;
    else if (mode === "7d") from = end - 7 * 24 * 3600 * 1000;
    else if (mode === "30d") from = end - 30 * 24 * 3600 * 1000;
    else if (mode === "all") { fromEl.value = ""; toEl.value = toLocalInput(end); return; }
    else return; // custom：保留用户输入
    fromEl.value = toLocalInput(from);
    toEl.value = toLocalInput(end);
  }

  // 面板边缘拖动调整大小（切换标签页不重置；大小记住到下次会话）
  const PANEL_SIZE_KEY = "ocgo:panel-size";
  function loadPanelSize() {
    try {
      const raw = localStorage.getItem(PANEL_SIZE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v.w === "number" && v.w > 0 && typeof v.h === "number" && v.h > 0) return v;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function savePanelSize(w, h) {
    try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (e) { /* ignore */ }
  }

  function initResize(panel) {
    const MIN_W = 380;
    const MIN_H = 320;
    const dirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    const onDown = (dir) => (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      const startW = rect.width;
      const startH = rect.height;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let w = startW;
        let h = startH;
        if (dir.includes("e")) w = startW + dx;
        if (dir.includes("s")) h = startH + dy;
        if (dir.includes("w")) w = startW - dx;
        if (dir.includes("n")) h = startH - dy;
        panel.style.width = Math.max(MIN_W, w) + "px";
        panel.style.height = Math.max(MIN_H, h) + "px";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        savePanelSize(parseInt(panel.style.width, 10) || panel.offsetWidth, parseInt(panel.style.height, 10) || panel.offsetHeight);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    for (const d of dirs) {
      const h = document.createElement("div");
      h.className = "ocgo-rh ocgo-rh-" + d;
      h.addEventListener("mousedown", onDown(d));
      panel.appendChild(h);
    }
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function downloadJson(name, obj) { downloadText(name + "-" + Date.now() + ".json", safeJson(obj)); }

  function copyLogs() {
    const text = logBuffer.map((e) => "[" + e.t + "][" + e.level + "][" + e.cat + "] " + e.msg + (e.data && e.data !== "null" ? " " + e.data : "")).join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => info("log", t("log.copied")),
        () => fallbackCopy(text)
      );
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); info("log", t("log.copied")); } catch (e) { warn("log", t("log.copyFail"), String(e)); }
    ta.remove();
  }  function buildUI() {
    const fab = el("button", { id: "ocgo-fab", title: t("app.title") }, "⚙");
    const panel = el("div", { id: "ocgo-panel" });
    panel.classList.add("ocgo-hidden");
    const savedSize = loadPanelSize();
    if (savedSize) {
      panel.style.width = savedSize.w + "px";
      panel.style.height = savedSize.h + "px";
    }

    const head = el("div", { id: "ocgo-head" });
    head.appendChild(el("span", { class: "ocgo-title" }, t("app.title")));
    const langSel = el("select", { id: "ocgo-lang" });
    for (const [v, label] of [["auto", "Auto"], ["zh", "中文"], ["en", "English"]]) {
      langSel.appendChild(el("option", { value: v }, label));
    }
    langSel.value = langPref;
    head.appendChild(langSel);
    const btnClose = el("button", { id: "ocgo-close", title: t("app.close") }, "✕");
    head.appendChild(btnClose);

    const tabs = el("div", { id: "ocgo-tabs" });
    const tabData = el("button", { "data-tab": "data" }, t("tabs.data"));
    const tabHistory = el("button", { "data-tab": "history" }, t("tabs.history"));
    const tabLog = el("button", { "data-tab": "log" }, t("tabs.log"));
    tabData.classList.add("ocgo-active");
    tabs.append(tabData, tabHistory, tabLog);

    const body = el("div", { id: "ocgo-body" });

    // ---- data tab ----
    const dataTab = el("div", { class: "ocgo-tab ocgo-active", id: "ocgo-tab-data" });
    const wsRow = el("div", { id: "ocgo-ws-row" });
    const ws = el("select", { id: "ocgo-ws" });
    ws.appendChild(el("option", { value: "" }, t("ws.notLoaded")));
    const btnRefreshWs = el("button", {}, t("ws.refresh"));
    wsRow.append(ws, btnRefreshWs);
    const btns = el("div", { id: "ocgo-btns" });
    const btnFetchAllUsage = el("button", { class: "ocgo-primary" }, t("usage.fetchAll"));
    const btnClearCache = el("button", {}, t("usage.clearHistory"));
    const btnStop = el("button", { class: "ocgo-stop", id: "ocgo-btn-stop" }, t("usage.stop"));
    btns.append(btnFetchAllUsage, btnClearCache, btnStop);
    const status = el("div", { id: "ocgo-status" }, t("app.ready"));
    const cacheState = el("div", { id: "ocgo-history-state" });
    // 分析区直接并入数据页
    const rangeRow = el("div", { id: "ocgo-range" });
    const rangeSel = el("select", { id: "ocgo-range-mode" });
    for (const [v, l] of [["today", t("range.today")], ["1d", t("range.1d")], ["7d", t("range.7d")], ["30d", t("range.30d")], ["all", t("range.all")], ["custom", t("range.custom")]]) {
      rangeSel.appendChild(el("option", { value: v }, l));
    }
    rangeSel.value = "today";
    const customRow = el("div", { id: "ocgo-custom-range" });
    const customFrom = el("input", { type: "datetime-local", id: "ocgo-range-from" });
    const customTo = el("input", { type: "datetime-local", id: "ocgo-range-to" });
    customRow.append(el("span", {}, t("range.from")), customFrom, el("span", {}, t("range.to")), customTo);
    rangeRow.append(el("span", {}, t("range.label")), rangeSel);
    const anaBtns = el("div", { id: "ocgo-analyze-btns" });
    const btnAnalyze = el("button", { class: "ocgo-primary" }, t("analysis.start"));
    const btnRefreshUsage = el("button", {}, t("analysis.refresh"));
    const btnExportReport = el("button", {}, t("analysis.export"));
    anaBtns.append(btnAnalyze, btnRefreshUsage, btnExportReport);
    const analysis = el("div", { id: "ocgo-analysis" }, t("analysis.placeholder"));
    dataTab.append(wsRow, btns, status, cacheState, rangeRow, customRow, anaBtns, analysis);

    // ---- history tab：近期 API 使用情况和成本 ----
    const historyTab = el("div", { class: "ocgo-tab", id: "ocgo-tab-history" });
    const historyBar = el("div", { id: "ocgo-range" });
    const historyRange = el("select", { id: "ocgo-history-range" });
    for (const [v, l] of [["today", t("range.today")], ["1d", t("range.1d")], ["7d", t("range.7d")], ["30d", t("range.30d")], ["all", t("range.all")], ["custom", t("range.custom")]]) {
      historyRange.appendChild(el("option", { value: v }, l));
    }
    historyRange.value = "7d";
    const historyCustom = el("div", { id: "ocgo-view-custom" });
    const historyFrom = el("input", { type: "datetime-local", id: "ocgo-history-from" });
    const historyTo = el("input", { type: "datetime-local", id: "ocgo-history-to" });
    historyCustom.append(el("span", {}, t("range.from")), historyFrom, el("span", {}, t("range.to")), historyTo);
    const historyBtns = el("div", { id: "ocgo-analyze-btns" });
    const btnHistoryExport = el("button", {}, t("history.export"));
    historyBtns.append(btnHistoryExport);
    const historyStatus = el("div", { id: "ocgo-history-status" });
    const historyTable = el("div", { id: "ocgo-history" }, t("history.placeholder"));
    historyTab.append(historyBar, historyCustom, historyBtns, historyStatus, historyTable);
    historyBar.append(el("span", {}, t("range.label")), historyRange);

    // ---- log tab ----
    const logTab = el("div", { class: "ocgo-tab", id: "ocgo-tab-log" });
    const logBtns = el("div", { id: "ocgo-btns" });
    const btnCopyLog = el("button", {}, t("log.copy"));
    const btnExportLog = el("button", {}, t("log.export"));
    const btnClearLog = el("button", {}, t("log.clear"));
    logBtns.append(btnCopyLog, btnExportLog, btnClearLog);
    const logWrap = el("div", { id: "ocgo-log-wrap" });
    const logHead = el("div", { id: "ocgo-log-head" });
    const logStats = el("span", { id: "ocgo-stats" });
    logHead.append(el("span", { class: "ocgo-title" }, t("log.title")), logStats);
    const logList = el("div", { id: "ocgo-log-list" });
    logWrap.append(logHead, logList);
    logTab.append(logBtns, logWrap);

    body.append(dataTab, historyTab, logTab);
    panel.append(head, tabs, body);
    document.body.append(fab, panel);
    initResize(panel);

    ui = { fab, panel, ws, status, cacheState, analysis, logList, logStats, btnStop,
      customFrom, customTo, rangeSel, dataTab, historyTab, historyRange, historyFrom, historyTo, historyStatus, historyTable, logTab, tabData, tabHistory, tabLog, langSel };    fab.addEventListener("click", () => panel.classList.toggle("ocgo-hidden"));
    btnClose.addEventListener("click", () => panel.classList.add("ocgo-hidden"));
    langSel.addEventListener("change", () => setLang(langSel.value));
    logHead.addEventListener("click", () => logList.style.display = logList.style.display === "none" ? "" : "none");
    for (const b of [tabData, tabHistory, tabLog]) {
      b.addEventListener("click", () => switchTab(b.getAttribute("data-tab")));
    }

    rangeSel.addEventListener("change", () => {
      rangeMode = rangeSel.value;
      customRow.classList.toggle("ocgo-show", rangeMode === "custom");
      syncRangeInputs(rangeMode, customFrom, customTo); // 自定义时间随预设范围联动
      runTask(t("task.analyze"), () => runAnalysis(false));         // 切换范围自动分析
    });

    btnStop.addEventListener("click", requestStop);

    btnRefreshWs.addEventListener("click", refreshWorkspaces);
    btnFetchAllUsage.addEventListener("click", () => runTask(t("task.fetchAll"), () => fetchAllUsageWithProgress(currentWorkspace())));
    btnClearCache.addEventListener("click", async () => { await clearCache(); setStatus(t("status.historyCleared")); await renderCacheState(); });

    btnAnalyze.addEventListener("click", () => runTask(t("task.analyze"), () => runAnalysis(false)));
    btnRefreshUsage.addEventListener("click", () => runTask(t("task.analyzeRefresh"), () => runAnalysis(true)));
    btnExportReport.addEventListener("click", exportReport);

    historyRange.addEventListener("change", () => {
      historyCustom.classList.toggle("ocgo-show", historyRange.value === "custom");
      syncRangeInputs(historyRange.value, historyFrom, historyTo); // 从/到 随范围变化
      renderHistory();
    });
    historyFrom.addEventListener("change", () => { if (historyRange.value === "custom") renderHistory(); });
    historyTo.addEventListener("change", () => { if (historyRange.value === "custom") renderHistory(); });
    btnHistoryExport.addEventListener("click", exportHistoryCsv);

    btnCopyLog.addEventListener("click", copyLogs);
    btnExportLog.addEventListener("click", () => downloadJson("opencodego-logs", logBuffer));
    btnClearLog.addEventListener("click", clearLogs);

    for (const entry of logBuffer) renderLogEntry(entry, true);
    updateLogStats();
    renderCacheState();
  }

  function switchTab(name) {
    if (!ui) return;
    const map = { data: ui.dataTab, history: ui.historyTab, log: ui.logTab };
    const btnMap = { data: ui.tabData, history: ui.tabHistory, log: ui.tabLog };
    for (const k in map) map[k].classList.toggle("ocgo-active", k === name);
    for (const k in btnMap) btnMap[k].classList.toggle("ocgo-active", k === name);
    if (name === "history") renderHistory();
  }

  // 通用任务包装：互斥 + 停止 + 状态恢复。fn 内部负责 setTaskBusy 的任务除外。
  async function runTask(label, fn) {
    if (task.running) {
      setStatus(t("status.taskBusy", { label: task.label }));
      warn("task", t("log.taskIgnored", { label: label, cur: task.label }));
      return;
    }
    setStatus(t("status.taskRunning", { label: label }));
    try {
      await fn();
    } catch (e) {
      if (e && e.name === "AbortError") {
        setStatus(t("status.taskStopped", { label: label }));
        info("task", t("log.taskStopped", { label: label }));
      } else {
        error("task", t("log.taskFailed", { label: label }), String(e && e.message || e));
        setStatus(t("status.taskFailed", { label: label, err: String(e && e.message || e) }));
      }
    } finally {
      await renderCacheState();
    }
  }

  async function exportReport() {
    const ws = currentWorkspace();
    if (!ws) { setStatus(t("status.noWorkspace")); return; }
    const usage = await loadUsage(ws);
    const range = currentRange();
    const analysis = analyzeUsage(usage.records, range.from, range.to);
    const report = {
      exportedAt: new Date().toISOString(),
      workspace: ws,
      range: { label: range.label, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
      cache: usage.meta || null,
      total: analysis.total,
      cacheHitRate: analysis.cacheHitRate,
      byModel: analysis.byModel,
      byDay: analysis.byDay,
    };
    downloadJson("opencodego-report", report);
    info("report", t("log.reportExported"), { range: range.label });
  }  function renderLogEntry(entry, skipLimit) {
    if (!ui) return;
    const list = ui.logList;
    if (!skipLimit && list.childElementCount > MAX_LOGS) list.innerHTML = "";
    const row = el("div", { class: "ocgo-log ocgo-" + entry.level });
    row.appendChild(el("span", { class: "ocgo-lv" }, entry.level));
    row.appendChild(el("span", { class: "ocgo-cat" }, entry.cat));
    row.appendChild(el("span", { style: "color:#8b949e;flex:0 0 64px" }, entry.t.slice(11, 19)));
    const msg = el("span", {}, entry.msg);
    if (entry.data && entry.data !== "null") {
      msg.appendChild(el("span", { style: "color:#7ee787" }, " " + String(entry.data)));
    }
    row.appendChild(msg);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  function updateLogStats() {
    if (!ui) return;
    const counts = { info: 0, warn: 0, error: 0 };
    for (const e of logBuffer) if (counts[e.level] !== undefined) counts[e.level]++;
    ui.logStats.textContent = t("log.stats", { n: logBuffer.length, e: counts.error, w: counts.warn, i: counts.info });
  }

  // =====================================================================
  // 12. 启动
  // =====================================================================
  function init() {
    if (!config.enabled) {
      console.log(t("log.disabled"));
      return;
    }
    if (location.hostname !== "opencode.ai") return;
    const start = () => {
      injectStyle();
      buildUI();
      info("boot", t("log.boot"), { version: "0.9.5", url: location.href });
      if (location.pathname.includes("/workspace/")) {
        refreshWorkspaces().catch(() => {});
      } else {
        setTimeout(() => { if (ui) ui.panel.classList.remove("ocgo-hidden"); }, 600);
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }

  // 尽早安装 fetch 钩子（document-start）
  if (config.enabled && location.hostname === "opencode.ai") {
    installFetchHook();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 测试钩子：e2e 冒烟测试依赖 cacheUsage/loadUsage/clearCache
  window.__ocgo = {
    version: "0.9.5",
    cacheUsage,
    loadUsage,
    assessUsageCache,
    clearCache,
  };
})();
