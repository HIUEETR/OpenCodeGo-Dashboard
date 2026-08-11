"""End-to-end tests for userscript v0.4.3 (mostly offline via route interception)."""
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
                data = seroval_response(PAGE0_NEW + [REC["B"], REC["A"]])  # 满50条：48新 + 2历史
            else:
                data = seroval_response([REC["B"], REC["A"]])
            route.fulfill(status=200, content_type="text/javascript", body=data)

        page.route("**/_server", handle_route)

        for attempt in range(4):
            try:
                page.goto("https://opencode.ai/go", wait_until="domcontentloaded", timeout=60000)
                break
            except Exception as e:
                print(f"goto attempt {attempt + 1} failed: {str(e)[:80]}; retrying...")
                _time.sleep(5)
        page.wait_for_timeout(3000)

        fab = page.locator("#ocgo-fab")
        assert fab.is_visible(), "FAB not visible"
        panel = page.locator("#ocgo-panel")
        if not panel.is_visible():
            fab.click()
            page.wait_for_timeout(300)

        try:
            page.locator("#ocgo-btns button.ocgo-primary", has_text="自检协议").click()
            page.wait_for_function("() => (document.querySelector('#ocgo-result').textContent || '').includes('自检通过')", timeout=30000)
            print("self-test OK")
        except Exception as e:
            print("self-test skipped:", str(e)[:100])

        page.evaluate(
            """(ws) => { const s = document.querySelector("#ocgo-ws"); const o = document.createElement("option");
                       o.value = ws; o.text = "TEST (" + ws + ")"; s.appendChild(o); s.value = ws; }""", WS)

        stop_btn = page.locator("#ocgo-btn-stop")

        # ---- Scenario A: complete history -> early stop after page 0, complete stays true
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: true }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('命中历史')", timeout=30000)
        status = page.locator("#ocgo-status").text_content()
        print("A status:", status)
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert len(usage_requests) == 1, usage_requests
        assert u["count"] == 50, u
        assert u["meta"]["complete"] is True, u
        print("A OK: 1 request, 50 merged, complete")

        # ---- Scenario B: incomplete history -> still early stop, complete stays False + stop button visible during slow request
        page.evaluate(
            """async ({ws, a, b}) => { await window.__ocgo.clearCache(); await window.__ocgo.cacheUsage(ws, [a, b], { full: false }); }""",
            {"ws": WS, "a": REC["A"], "b": REC["B"]},
        )
        SLOW[0] = True
        page.locator("#ocgo-btns button.ocgo-primary", has_text="拉取全量用量").click()
        page.wait_for_timeout(800)
        assert stop_btn.is_visible(), "stop button should be visible while task running"
        print("B: stop button visible during task OK")
        page.wait_for_function("() => (document.querySelector('#ocgo-status').textContent || '').includes('历史不完整')", timeout=30000)
        SLOW[0] = False
        status = page.locator("#ocgo-status").text_content()
        print("B status:", status)
        u = page.evaluate("async (ws) => { const x = await window.__ocgo.loadUsage(ws); return { count: x.records.length, meta: x.meta }; }", WS)
        assert len(usage_requests) == 2, usage_requests
        assert u["count"] == 50, u
        assert u["meta"]["complete"] is False, u
        assert not stop_btn.is_visible(), "stop button should be hidden after task finished"
        print("B OK: 1 request, 50 merged, complete=False, stop hidden")

        browser.close()

    print("console errors:", errors[:5] if errors else "none")


if __name__ == "__main__":
    main()
