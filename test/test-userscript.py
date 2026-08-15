"""End-to-end tests for userscript v0.10.0 (offline via route interception + usage view)."""
import json
import time as _time
from pathlib import Path

from playwright.sync_api import sync_playwright

USER_JS = Path(__file__).resolve().parent / "opencodego-dashboard.user.js"
if not USER_JS.exists():
    USER_JS = Path(__file__).resolve().parent.parent / "opencodego-dashboard.user.js"
WS = "wrk_TEST"
USAGE_ID = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c"
WORKSPACES_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f"

REC = {
    "A": {"id": "usg_a", "timeCreated": "2026-08-10T09:00:00.000Z", "model": "deepseek-v4-flash",
          "inputTokens": 1000, "outputTokens": 500, "reasoningTokens": 200, "cacheReadTokens": 9000,
          "cacheWrite5mTokens": None, "cacheWrite1hTokens": None, "cost": 100000},
    "B": {"id": "usg_b", "timeCreated": "2026-08-10T10:00:00.000Z", "model": "deepseek-v4-flash",
          "inputTokens": 2000, "outputTokens": 1000, "reasoningTokens": 300, "cacheReadTokens": 18000,
          "cacheWrite5mTokens": None, "cacheWrite1hTokens": None, "cost": 200000},
}

PAGE0_NEW = [
    {"id": "usg_d%02d" % i, "timeCreated": "2026-08-11T%02d:00:00.000Z" % (i % 24),
     "model": "deepseek-v4-flash", "inputTokens": 100 + i, "outputTokens": 50 + i,
     "reasoningTokens": 10 + i, "cacheReadTokens": 900 + i, "cacheWrite5mTokens": None,
     "cacheWrite1hTokens": None, "cost": 1000 + i}
    for i in range(48)
]


def js_rec(r):
    return ('{id:"%s",workspaceID:"wrk_TEST",timeCreated:new Date("%s"),model:"%s",provider:"inf-go.openai",'
            'inputTokens:%s,outputTokens:%s,reasoningTokens:%s,cacheReadTokens:%s,cacheWrite5mTokens:null,'
            'cacheWrite1hTokens:null,cost:%s,keyID:"k",sessionID:"",enrichment:{plan:"lite"}}') % (
        r["id"], r["timeCreated"], r["model"], r["inputTokens"], r["outputTokens"], r["reasoningTokens"],
        r["cacheReadTokens"], r["cost"])


def seroval_response(records):
    expr = ('((self.$R=self.$R||{})["server-fn:test"]=[],($R=>$R[0]=[%s])("server-fn:test"))'
            % ",".join(js_rec(r) for r in records))
    b = expr.encode("utf-8")
    return (";0x%08x;" % len(b)).encode("utf-8") + b


def seroval_array(values):
    # plain array of pre-formatted JS literals (e.g. ['"wrk_TEST"'])
    expr = ('((self.$R=self.$R||{})["server-fn:test"]=[],($R=>$R[0]=[%s])("server-fn:test"))'
            % ",".join(values))
    b = expr.encode("utf-8")
    return (";0x%08x;" % len(b)).encode("utf-8") + b


POOL_BODY = json.dumps({"message": "target: opencode.-.primary: vttablet: rpc error: code = ResourceExhausted desc = transaction pool connection limit exceeded (CallerID: l33kfo3ift2ikdn2b8dk)", "code": "UNKNOWN"})


def make_page_rows(n, count=50):
    return [
        {"id": "usg_p%d_%02d" % (n, i),
         "timeCreated": "2026-08-12T%02d:%02d:00.000Z" % ((n + i) % 24, i % 60),
         "model": "deepseek-v4-flash", "inputTokens": 1000 + n * 100 + i, "outputTokens": 500 + i,
         "reasoningTokens": 100 + i, "cacheReadTokens": 9000 + i, "cacheWrite5mTokens": None,
         "cacheWrite1hTokens": None, "cost": 100000 + i}
        for i in range(count)
    ]


def goto_retry(page, url):
    for attempt in range(4):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            return
        except Exception as e:
            print(f"goto attempt {attempt + 1} failed: {str(e)[:80]}; retrying...")
            _time.sleep(5)


def main():
    usage_requests = []
    usage_counts = {}
    SLOW = [False]
    FAIL = {"fail_once": {}, "always_fail": set(), "http_fail": {}, "full_until": 1}

    def reset_fail():
        FAIL.update({"fail_once": {}, "always_fail": set(), "http_fail": {}, "full_until": 1})
        usage_counts.clear()
        usage_requests.clear()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        # v0.9.0: default to zh UI (Playwright browsers default to en-US); language switch is tested below
        ctx.add_init_script("localStorage.setItem('ocgo:config', JSON.stringify({lang:'zh', enabled:true}))")
        ctx.add_init_script(USER_JS.read_text(encoding="utf-8"))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text[:200]}") if m.type == "error" else None)

        def handle_route(route):
            req = route.request
            if req.headers.get("x-server-id") == WORKSPACES_ID:
                route.fulfill(status=200, content_type="text/javascript", body=seroval_array(['"wrk_TEST"']))
                return
            if req.headers.get("x-server-id") != USAGE_ID:
                return route.continue_()
            usage_requests.append(req)
            body = json.loads(req.post_data or "{}")
            try:
                page_num = body["t"]["a"][1]["s"]
            except Exception:
                page_num = -1
            usage_counts[page_num] = usage_counts.get(page_num, 0) + 1
            if SLOW[0]:
                _time.sleep(2.5)
            if page_num in FAIL["always_fail"]:
                route.fulfill(status=400, content_type="application/json", body=POOL_BODY)
                return
            if page_num in FAIL["fail_once"] and FAIL["fail_once"][page_num] > 0:
                FAIL["fail_once"][page_num] -= 1
                route.fulfill(status=400, content_type="application/json", body=POOL_BODY)
                return
            if page_num in FAIL["http_fail"]:
                status, body = FAIL["http_fail"][page_num]
                route.fulfill(status=status, content_type="application/json", body=body)
                return
            if page_num == 0:
                data = seroval_response(PAGE0_NEW + [REC["B"], REC["A"]])
            elif page_num < FAIL["full_until"]:
                data = seroval_response(make_page_rows(page_num, 50))
            else:
                data = seroval_response([REC["B"], REC["A"]])
            route.fulfill(status=200, content_type="text/javascript", body=data)

        page.route("**/_server", handle_route)

        goto_retry(page, "https://opencode.ai/go")
        page.wait_for_timeout(3000)

        fab = page.locator("#ocgo-fab")
        assert fab.is_visible(), "FAB not visible"
        panel = page.locator("#ocgo-panel")
        if not panel.is_visible():
            fab.click()
            page.wait_for_timeout(300)

        # v0.7.0: tabs = 数据/使用历史/日志; no Keys; no 打开用量页面; no 调试 toggle
        tab_names = page.locator("#ocgo-tabs button").all_text_contents()
        print("tabs:", tab_names)
        assert tab_names == ["数据", "使用历史", "日志"], tab_names
        assert page.locator("#ocgo-btns button", has_text="Keys").count() == 0
        assert page.locator("#ocgo-btns button", has_text="打开用量页面").count() == 0
        assert page.locator("#ocgo-btns button", has_text="拉取全量用量").count() == 1
        head_labels = page.locator("#ocgo-head label").all_text_contents()
        print("head labels:", head_labels)
        assert head_labels == [], head_labels  # 总开关/日志/调试 勾选框全部移除
        assert page.locator("#ocgo-head input[type=checkbox]").count() == 0
        print("UI OK: tabs=数据/使用历史/日志, no Keys/open-view, no toggles")

        # v0.9.0: language switch (zh -> en -> zh) rebuilds the UI in-place
        page.select_option("#ocgo-lang", "en")
        page.wait_for_timeout(300)
        en_tabs = page.locator("#ocgo-tabs button").all_text_contents()
        print("en tabs:", en_tabs)
        assert en_tabs == ["Data", "Usage History", "Logs"], en_tabs
        assert page.locator("#ocgo-btns button", has_text="Fetch all usage").count() == 1
        assert page.locator("#ocgo-btns button", has_text="Clear history").count() == 1
        assert page.locator("#ocgo-close").is_visible()
        page.select_option("#ocgo-lang", "zh")
        page.wait_for_timeout(300)
        zh_tabs = page.locator("#ocgo-tabs button").all_text_contents()
        assert zh_tabs == ["数据", "使用历史", "日志"], zh_tabs
        assert page.locator("#ocgo-btns button", has_text="拉取全量用量").count() == 1
        print("language switch OK: en tabs + buttons, back to zh")

        # Load the workspace list through the real RPC path (intercepted offline).
        # NOTE: refresh button lives in #ocgo-ws-row (not #ocgo-btns, which is the data/log button row).
        page.locator("#ocgo-ws-row button", has_text="刷新工作区").click()
        page.wait_for_function(
            "() => Array.from(document.querySelector('#ocgo-ws').options).some(o => o.value === 'wrk_TEST')",
            timeout=10000)
        page.select_option("#ocgo-ws", WS)
        assert page.locator("#ocgo-ws").input_value() == WS

        # v0.9.1 regression: workspace selection must survive language switch (no refresh needed)
        page.select_option("#ocgo-lang", "en")
        page.wait_for_timeout(300)
        assert page.locator("#ocgo-ws").input_value() == WS, page.locator("#ocgo-ws").input_value()
        page.select_option("#ocgo-lang", "zh")
        page.wait_for_timeout(300)
        assert page.locator("#ocgo-ws").input_value() == WS, page.locator("#ocgo-ws").input_value()
        assert page.locator("#ocgo-ws option", has_text="wrk_TEST").count() == 1
        print("workspace survives language switch OK (value=" + page.locator("#ocgo-ws").input_value() + ")")

        # Scenario A: complete history -> early stop after page 0
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: true }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('命中历史')", timeout=30000)
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert len(usage_requests) == 1, usage_requests
        assert u["count"] == 50 and u["meta"]["complete"] is True, u
        print("A OK: 1 request, 50 merged, complete")

        # Scenario B (v0.9.3): incomplete history -> full fetch pages to the end and marks complete
        # (no early "hit history" stop when history is incomplete, so no false 不完整 warning)
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: false }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        SLOW[0] = True
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_timeout(800)
        assert page.locator("#ocgo-btn-stop").is_visible(), "stop button should be visible while task running"
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('全量用量拉取完成')", timeout=30000)
        SLOW[0] = False
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert len(usage_requests) == 3, usage_requests  # A:1 + B: page0 + page1
        assert u["count"] == 50 and u["meta"]["complete"] is True, u
        assert not page.locator("#ocgo-btn-stop").is_visible()
        assert "不完整" not in page.locator("#ocgo-history-state").text_content(), page.locator("#ocgo-history-state").text_content()
        print("B OK: full fetch from incomplete history -> 2 requests, 50 merged, complete=True, no false warning")

        # ---- v0.10.0: degraded retry ----
        # C: transient pool error on page 1 -> retried once, fetch completes
        reset_fail()
        FAIL["fail_once"] = {1: 1}
        page.evaluate("async (ws) => { await window.__ocgo.clearCache(); }", WS)
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('全量用量拉取完成')", timeout=40000)
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert usage_counts.get(1, 0) == 2, usage_counts  # page 1 failed once, then retried
        assert u["meta"]["complete"] is True, u
        log_text = page.locator("#ocgo-log-list").text_content()
        assert "重试" in log_text, log_text[:500]
        print("C OK: transient pool error retried once, fetch complete, page1 x2")

        # D: failure enters degraded mode, 5 clean pages exit it
        reset_fail()
        FAIL["fail_once"] = {0: 1}
        FAIL["full_until"] = 6
        page.evaluate("async (ws) => { await window.__ocgo.clearCache(); }", WS)
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('全量用量拉取完成')", timeout=60000)
        log_text = page.locator("#ocgo-log-list").text_content()
        assert "退级模式" in log_text, log_text[:500]
        assert "退出退级模式" in log_text, log_text[:500]
        assert usage_counts.get(0, 0) == 2, usage_counts  # page 0 failed once, then retried
        print("D OK: degraded mode entered after failure and exited after 5 clean pages")

        # E: persistent pool error -> retries exhausted -> fetch aborts, partial history kept incomplete
        reset_fail()
        FAIL["always_fail"] = {2}
        FAIL["full_until"] = 2
        page.evaluate("async (ws) => { await window.__ocgo.clearCache(); }", WS)
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('失败')", timeout=60000)
        assert usage_counts.get(2, 0) == 5, usage_counts  # 1 initial + 4 retries
        log_text = page.locator("#ocgo-log-list").text_content()
        assert "中止拉取" in log_text, log_text[:500]
        page.wait_for_function(
            """async (ws) => { const x = await window.__ocgo.loadUsage(ws); return x.records.length >= 100 && x.meta.complete === false; }""",
            arg=WS, timeout=10000)
        print("E OK: exhausted retries abort fetch, partial history kept incomplete")

        # F: non-retryable error -> no retry; isRetryableError classification
        reset_fail()
        FAIL["http_fail"] = {1: (403, '{"message":"forbidden"}')}
        FAIL["full_until"] = 1
        page.evaluate("async (ws) => { await window.__ocgo.clearCache(); }", WS)
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('失败')", timeout=30000)
        assert usage_counts.get(1, 0) == 1, usage_counts  # non-retryable 403 -> single attempt
        retryable = page.evaluate("""() => ({
          pool: window.__ocgo.isRetryableError(new Error('HTTP 400: usage.list -> transaction pool connection limit exceeded')),
          http500: window.__ocgo.isRetryableError(new Error('HTTP 500: usage.list -> boom')),
          http403: window.__ocgo.isRetryableError(new Error('HTTP 403: usage.list -> nope')),
          decode: window.__ocgo.isRetryableError(new Error('decode failed')),
        })""")
        assert retryable["pool"] and retryable["http500"], retryable
        assert not retryable["http403"] and not retryable["decode"], retryable
        print("F OK: non-retryable 403 fails immediately; isRetryableError classification correct")

        # G: clear history requires inline confirmation
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: true }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        confirm_bar = page.locator("#ocgo-clear-confirm")
        assert not confirm_bar.is_visible(), "confirm bar should be hidden by default"
        page.locator("#ocgo-btns button", has_text="清空历史").click()
        page.wait_for_timeout(200)
        assert confirm_bar.is_visible(), "confirm bar should appear after clicking 清空历史"
        bar_text = confirm_bar.text_content()
        assert "确认清空" in bar_text and "取消" in bar_text, bar_text
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length }; }", WS)
        assert u["count"] == 2, u  # not cleared yet
        # cancel keeps history
        page.locator("#ocgo-clear-confirm button", has_text="取消").click()
        page.wait_for_timeout(200)
        assert not confirm_bar.is_visible(), "confirm bar should hide after cancel"
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length }; }", WS)
        assert u["count"] == 2, u  # history untouched
        # confirm clears history
        page.locator("#ocgo-btns button", has_text="清空历史").click()
        page.wait_for_timeout(200)
        page.locator("#ocgo-clear-confirm button", has_text="确认清空").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('历史已清空')", timeout=10000)
        page.wait_for_timeout(200)
        assert not confirm_bar.is_visible(), "confirm bar should hide after clearing"
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length }; }", WS)
        assert u["count"] == 0, u
        print("G OK: inline confirmation required for clear history (cancel keeps, confirm clears)")

        # History tab: seed cache (50 rows from scenario A) then render usage history table
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: true }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        page.locator("#ocgo-tabs button", has_text="使用历史").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-history').textContent || '').includes('deepseek-v4-flash')", timeout=15000)
        htext = page.locator("#ocgo-history").text_content()
        hstatus = page.locator("#ocgo-history-status").text_content()
        print("history status:", hstatus)
        print("history table head:", htext[:120].replace("\n", " "))
        assert "请求时间" in htext and "模型" in htext and "成本" in htext, htext[:200]
        assert "deepseek-v4-flash" in htext
        assert "共 2 条" in hstatus, hstatus
        # v0.8.1: column order 输入->推理->缓存读->输出->成本; no 会话; 24h time yyyy/MM/dd HH:mm:ss
        idx = [htext.index(k) for k in ["输入", "推理", "缓存读", "输出", "成本"]]
        assert idx == sorted(idx), (idx, htext[:200])
        assert "会话" not in htext, htext[:200]
        import re as _re
        assert _re.search(r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}", htext), htext[:200]
        print("history tab OK: ordered cols, 24h time, no session col")

        # range switch -> all shows 2 rows too
        page.select_option("#ocgo-history-range", "all")
        page.wait_for_timeout(300)
        hstatus2 = page.locator("#ocgo-history-status").text_content()
        assert "共 2 条" in hstatus2, hstatus2
        print("history range OK")

        # ---- v0.8.0 checks ----
        # default analysis range = today
        page.locator("#ocgo-tabs button", has_text="数据").click()
        page.wait_for_timeout(200)
        assert page.locator("#ocgo-range-mode").input_value() == "today", "analysis range should default to today"
        # v0.9.7 regression: first "开始分析" (without touching the range select) must use 当天, not 最近7天
        page.locator("#ocgo-analyze-btns button", has_text="开始分析").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('分析完成：当天')", timeout=15000)
        assert "0 条" in page.locator("#ocgo-status").text_content(), page.locator("#ocgo-status").text_content()
        print("first analysis uses 当天 OK")
        # switch range -> auto analyze (cache exists with A/B)
        page.select_option("#ocgo-range-mode", "7d")
        page.wait_for_function("() => (document.querySelector('#ocgo-analysis').textContent || '').includes('缓存命中率')", timeout=15000)
        print("auto-analyze on range switch OK")
        # v0.9.4: by-model table has a per-model cache hit rate column
        model_tbl = page.locator("#ocgo-analysis table.ocgo-tbl").first
        model_head = model_tbl.locator("tr").first.locator("th").all_text_contents()
        print("model table head:", model_head)
        assert "缓存命中率" in model_head, model_head
        cells = model_tbl.locator("tr").nth(1).locator("td").all_text_contents()
        print("model row:", cells)
        assert cells[5].endswith("%"), cells  # cacheRead 27000 / (input 3000 + cacheRead 27000) = 90.00%
        assert cells[5] == "90.00%", cells
        print("per-model cache hit rate OK")
        # v0.9.5: status trimmed (no ｜持久历史 note) and cache state uses 24h time, no 用量[持久] prefix
        status_text = page.locator("#ocgo-status").text_content()
        assert "持久历史" not in status_text and "｜" not in status_text, status_text
        cache_state_text = page.locator("#ocgo-history-state").text_content()
        assert "用量[持久]" not in cache_state_text, cache_state_text
        assert _re.search(r"\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}", cache_state_text), cache_state_text
        print("status/cache-state trimmed + 24h time OK")
        # data-page custom inputs synced after choosing 7d then custom
        page.select_option("#ocgo-range-mode", "custom")
        page.wait_for_timeout(200)
        from_v = page.locator("#ocgo-range-from").input_value()
        assert from_v, "custom from should be synced"
        print("data custom from synced:", from_v)
        # v0.9.2: analysis range includes "all" -> shows all history
        assert page.locator("#ocgo-range-mode option[value=all]").count() == 1
        page.select_option("#ocgo-range-mode", "all")
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('全部')", timeout=15000)
        print("analysis all-range OK")
        # history custom inputs follow range (7d -> now-7d)
        page.locator("#ocgo-tabs button", has_text="使用历史").click()
        page.wait_for_timeout(200)
        page.select_option("#ocgo-history-range", "all")
        page.wait_for_timeout(150)
        page.select_option("#ocgo-history-range", "7d")
        page.wait_for_timeout(200)
        hfrom = page.locator("#ocgo-history-from").input_value()
        hto = page.locator("#ocgo-history-to").input_value()
        print("history from/to:", hfrom, hto)
        assert hfrom and hto, "history custom inputs should follow range"
        from datetime import datetime, timedelta
        fdt = datetime.strptime(hfrom, "%Y-%m-%dT%H:%M")
        expected = datetime.now() - timedelta(days=7)
        assert abs((fdt - expected).total_seconds()) < 180, (fdt, expected)
        print("history 7d sync OK (from ~ now-7d)")
        # resize handles present
        assert page.locator("#ocgo-panel .ocgo-rh").count() == 8, "expected 8 resize handles"
        print("resize handles OK")
        # clear button renamed to 清空历史
        assert page.locator("#ocgo-btns button", has_text="清空历史").count() == 1
        assert page.locator("#ocgo-btns button", has_text="清空缓存").count() == 0
        print("wording OK: 清空历史, no 缓存 button")

        # v0.8.3: resize persists across reload
        box = page.locator("#ocgo-panel .ocgo-rh-se").bounding_box()
        assert box, "se resize handle missing"
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.mouse.move(min(box["x"] + box["width"] / 2 + 80, 1270), min(box["y"] + box["height"] / 2 + 80, 710), steps=5)
        page.mouse.up()
        page.wait_for_timeout(200)
        size = json.loads(page.evaluate("() => localStorage.getItem('ocgo:panel-size') || 'null'"))
        assert size and size["w"] > 0 and size["h"] > 0, size
        print("resize saved:", size)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        w = page.evaluate("() => document.querySelector('#ocgo-panel').style.width")
        h = page.evaluate("() => document.querySelector('#ocgo-panel').style.height")
        assert w == str(size["w"]) + "px" and h == str(size["h"]) + "px", (w, h, size)
        print("resize restored after reload OK")

        # v0.9.0: log list vertical size follows the resized panel (was fixed at 150px)
        if not page.locator("#ocgo-panel").is_visible():
            page.locator("#ocgo-fab").click()
            page.wait_for_timeout(300)
        page.locator("#ocgo-tabs button", has_text="日志").click()
        page.wait_for_timeout(300)
        log_h = page.locator("#ocgo-log-list").evaluate("el => el.clientHeight")
        print("log list height after resize:", log_h)
        assert log_h > 150, log_h
        print("log list grows with panel height OK")

        browser.close()

    print("console errors:", errors[:5] if errors else "none")


if __name__ == "__main__":
    main()
