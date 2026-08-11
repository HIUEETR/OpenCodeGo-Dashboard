"""End-to-end tests for userscript v0.6.0 (offline via route interception + usage view)."""
import json
import time as _time
from pathlib import Path

from playwright.sync_api import sync_playwright

USER_JS = Path(__file__).resolve().parent / "opencodego-dashboard.user.js"
WS = "wrk_TEST"
USAGE_ID = "bfd684bfc2e4eed05cd0b518f5e4eafd3f3376e3938abb9e536e7c03df831e5c"

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
    SLOW = [False]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        ctx.add_init_script(USER_JS.read_text(encoding="utf-8"))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text[:200]}") if m.type == "error" else None)

        def handle_route(route):
            req = route.request
            if req.headers.get("x-server-id") != USAGE_ID:
                return route.continue_()
            usage_requests.append(req)
            body = json.loads(req.post_data or "{}")
            try:
                page_num = body["t"]["a"][1]["s"]
            except Exception:
                page_num = -1
            if SLOW[0]:
                _time.sleep(2.5)
            if page_num == 0:
                data = seroval_response(PAGE0_NEW + [REC["B"], REC["A"]])
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

        page.evaluate(
            """(ws) => { const s = document.querySelector("#ocgo-ws"); const o = document.createElement("option");
                       o.value = ws; o.text = "TEST (" + ws + ")"; s.appendChild(o); s.value = ws; }""", WS)

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

        # Scenario B: incomplete history -> still early stop + stop button visible during slow request
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: false }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        SLOW[0] = True
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_timeout(800)
        assert page.locator("#ocgo-btn-stop").is_visible(), "stop button should be visible while task running"
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('历史不完整')", timeout=30000)
        SLOW[0] = False
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert len(usage_requests) == 2, usage_requests
        assert u["count"] == 50 and u["meta"]["complete"] is False, u
        assert not page.locator("#ocgo-btn-stop").is_visible()
        print("B OK: 1 request, 50 merged, complete=False, stop hidden")

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
        # switch range -> auto analyze (cache exists with A/B)
        page.select_option("#ocgo-range-mode", "7d")
        page.wait_for_function("() => (document.querySelector('#ocgo-analysis').textContent || '').includes('缓存命中率')", timeout=15000)
        print("auto-analyze on range switch OK")
        # data-page custom inputs synced after choosing 7d then custom
        page.select_option("#ocgo-range-mode", "custom")
        page.wait_for_timeout(200)
        from_v = page.locator("#ocgo-range-from").input_value()
        assert from_v, "custom from should be synced"
        print("data custom from synced:", from_v)
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

        browser.close()

    print("console errors:", errors[:5] if errors else "none")


if __name__ == "__main__":
    main()
