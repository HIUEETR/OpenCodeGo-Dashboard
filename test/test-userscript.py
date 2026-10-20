"""End-to-end tests for the OpenCodeGo Dashboard Assistant userscript.

The console document and every API request are intercepted locally, so the test
does not depend on a real OpenCode session or network access.
"""
import argparse
import json
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

USER_JS = Path(__file__).resolve().parent.parent / "opencodego-dashboard.user.js"
WORKSPACE = "wrk_TEST"
SECOND_WORKSPACE = "wrk_SECOND"
HTML = """
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>OpenCode Console</title></head>
  <body><main>OpenCode Console fixture</main></body>
</html>
"""
HTML_DOCS = """
<!doctype html>
<html lang="en">
  <body>
    <div data-plan-panel="go">
      <table>
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead>
        <tbody>
          <tr><td>DeepSeek V4.1 Flash</td><td>$0.30</td><td>$1.20</td><td>$0.006</td><td>-</td><td><strong>$80</strong></td></tr>
          <tr><td>GPT 5.6 Luna (≤ 272K tokens)</td><td>$0.20</td><td>$1.20</td><td>$0.02</td><td>$0.25</td><td><strong>$15</strong></td></tr>
        </tbody>
      </table>
    </div>
    <div data-plan-panel="go-plus">
      <table>
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr></thead>
        <tbody>
          <tr><td>DeepSeek V4.1 Flash</td><td>$0.30</td><td>$1.20</td><td>$0.006</td><td>-</td><td><strong>$160</strong></td></tr>
          <tr><td>GPT 5.6 Luna (≤ 272K tokens)</td><td>$0.20</td><td>$1.20</td><td>$0.02</td><td>$0.25</td><td><strong>$60</strong></td></tr>
        </tbody>
      </table>
    </div>
    <table>
      <thead><tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr></thead>
      <tbody>
        <tr><td>DeepSeek V4.1 Flash</td><td>deepseek-v4.1-flash</td><td>https://opencode.ai/inference/go/openai/v1/chat/completions</td><td>@ai-sdk/openai-compatible</td></tr>
        <tr><td>GPT 5.6 Luna</td><td>gpt-5.6-luna</td><td>https://opencode.ai/inference/go/openai/v1/responses</td><td>@ai-sdk/openai</td></tr>
      </tbody>
    </table>
  </body>
</html>
"""


def api_record(
    index: int,
    *,
    workspace: str = WORKSPACE,
    outcome: str = "succeeded",
    model: str = "deepseek-v4.1-flash",
    cache_write: int = 0,
) -> dict:
    started = int(time.time() * 1000) - (10 + index) * 60_000
    output = 220 + index * 10
    return {
        "id": f"req_{index}",
        "requestID": f"request_{index}",
        "workspaceID": workspace,
        "startedAt": started,
        "finishedAt": started + 3200,
        "durationMs": 3200,
        "outcome": outcome,
        "category": "inference",
        "protocol": "openai-responses",
        "product": "go",
        "path": "/inference/go/openai/v1/responses",
        "method": "POST",
        "stream": True,
        "sessionID": f"session_{index}",
        "userID": "user_1",
        "serviceAccountID": "",
        "serviceAPIKeyID": "key_1",
        "requestedModel": model,
        "model": model,
        "provider": "opencode",
        "statusCode": 200 if outcome == "succeeded" else 502,
        "timeToFirstTokenMs": 800,
        "firstTokenAt": started + 800,
        "lastTokenAt": started + 3000,
        "inputTokens": 100,
        "outputTokens": output,
        "reasoningTokens": 20,
        "cacheReadTokens": 1000,
        "cacheWriteTokens": cache_write,
        "cacheWrite1hTokens": 0,
        "cost": 0.001,
    }


def install_routes(page, requests_seen, *, rate_limit_once=False, unauthorized=False, cache_write=0, pricing_seen=None, status_seen=None, status_unauthorized=False, zero_token_model=None, log_delay_ms=0):
    limited = {"done": False}

    def handler(route):
        request = route.request
        url = request.url
        if url.endswith("/console/api/go/status"):
            if status_seen is not None:
                status_seen.append({"url": url, "headers": request.headers})
            if status_unauthorized:
                route.fulfill(
                    status=401,
                    content_type="application/json",
                    body=json.dumps({"message": "unauthorized"}),
                )
                return
            now = int(time.time() * 1000)
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "product": "go",
                    "cancelAtPeriodEnd": False,
                    "access": {
                        "startsAt": now - 10 * 86_400_000,
                        "endsAt": now + 20 * 86_400_000,
                        "meters": {
                            "fiveHour": {
                                "startsAt": now - 2 * 3_600_000,
                                "resetsAt": now + 3 * 3_600_000,
                                "limitMicroCents": 1_200_000_000,
                                "usedMicroCents": 300_000_000,
                            },
                            "week": {
                                "startsAt": now - 2 * 86_400_000,
                                "resetsAt": now + 5 * 86_400_000,
                                "limitMicroCents": 3_000_000_000,
                                "usedMicroCents": 600_000_000,
                            },
                            "month": {
                                "resetsAt": now + 20 * 86_400_000,
                                "limitMicroCents": 6_000_000_000,
                                "usedMicroCents": 1_000_000_000,
                            },
                        },
                    },
                }),
            )
            return
        if url.endswith("/console/api/user/workspaces"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps([
                    {"id": WORKSPACE, "name": "Default", "role": "owner", "memberCount": 1, "avatarUrl": None},
                    {"id": SECOND_WORKSPACE, "name": "Second", "role": "owner", "memberCount": 1, "avatarUrl": None},
                ]),
            )
            return
        if urlparse(url).path.endswith("/console/api/usage/users"):
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "items": [{
                        "userId": "user_1",
                        "serviceUserId": "",
                        "principalType": "member",
                        "email": "alice@example.com",
                        "name": "Alice",
                        "avatarUrl": None,
                    }],
                    "page": 1,
                    "pageSize": 100,
                    "total": 1,
                    "pageCount": 1,
                }),
            )
            return
        if urlparse(url).path == "/v2/docs/console/go/":
            if pricing_seen is not None:
                pricing_seen.append(url)
            route.fulfill(status=200, content_type="text/html", body=HTML_DOCS)
            return
        if "/console/api/request-logs" in url:
            requests_seen.append({"url": url, "headers": request.headers})
            if log_delay_ms:
                time.sleep(log_delay_ms / 1000)
            if unauthorized:
                route.fulfill(
                    status=401,
                    content_type="application/json",
                    body=json.dumps({"message": "unauthorized"}),
                )
                return
            if rate_limit_once and not limited["done"]:
                limited["done"] = True
                route.fulfill(
                    status=429,
                    headers={"content-type": "application/json", "retry-after": "0"},
                    body=json.dumps({"message": "slow down"}),
                )
                return
            query = parse_qs(urlparse(url).query)
            cursor = query.get("cursor", [None])[0]
            workspace = request.headers.get("x-org-id", WORKSPACE)
            if cursor is None:
                items = [
                    api_record(1, workspace=workspace, cache_write=cache_write),
                    api_record(2, workspace=workspace, cache_write=cache_write),
                ]
                if zero_token_model:
                    empty = api_record(0, workspace=workspace, model=zero_token_model)
                    empty.update({
                        "inputTokens": 0,
                        "outputTokens": 0,
                        "reasoningTokens": 0,
                        "cacheReadTokens": 0,
                        "cacheWriteTokens": 0,
                        "cacheWrite1hTokens": 0,
                        "cost": 0,
                    })
                    items.insert(0, empty)
                next_cursor = "page-2"
            else:
                items = [api_record(3, workspace=workspace, cache_write=cache_write)]
                next_cursor = None
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({
                    "items": items,
                    "nextCursor": next_cursor,
                    "until": int(time.time() * 1000),
                    "retentionDays": 30,
                }),
            )
            return
        if "opencode.ai/console/" in url:
            route.fulfill(status=200, content_type="text/html", body=HTML)
            return
        route.fulfill(status=404, content_type="text/plain", body="not found")

    page.route("https://opencode.ai/**", handler)


def open_fixture(context, page, *, open_panel=True, language="zh", default_range="7d"):
    language_setup = "" if language is None else f"localStorage.setItem('ocgo-lens:language', JSON.stringify({json.dumps(language)}));"
    range_setup = "" if default_range is None else f"localStorage.setItem('ocgo-lens:range', JSON.stringify({json.dumps(default_range)}));"
    context.add_init_script(
        f"""
        if (!localStorage.getItem('ocgo-lens:panelState')) {{
          localStorage.setItem('ocgo-lens:panelState', JSON.stringify({{open:{str(open_panel).lower()}}}));
        }}
        if (!localStorage.getItem('ocgo-lens:language')) {{
          {language_setup}
        }}
        {range_setup}
        """
    )
    context.add_init_script(USER_JS.read_text(encoding="utf-8"))
    page.goto(f"https://opencode.ai/console/{WORKSPACE}", wait_until="domcontentloaded")
    page.wait_for_selector("#ocgo-lens-host", state="attached", timeout=15000)
    page.wait_for_selector(".ocgo-panel", state="visible" if open_panel else "hidden", timeout=15000)


def test_range_presets():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        install_routes(page, [])
        open_fixture(context, page, default_range=None)

        range_select = page.get_by_label("范围")
        assert range_select.input_value() == "5h"
        assert range_select.locator("option").evaluate_all(
            "options => options.map(option => option.value)"
        ) == ["1h", "5h", "24h", "7d", "30d", "all", "custom"]
        assert range_select.locator("option:checked").inner_text() == "近 5 小时"

        range_select.select_option("7d")
        assert page.evaluate("localStorage.getItem('ocgo-lens:range')") == '"7d"'
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".ocgo-panel", state="visible", timeout=15000)
        assert page.get_by_label("范围").input_value() == "7d"
        browser.close()


def test_main_flow():
    requests_seen = []
    pricing_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, pricing_seen=pricing_seen)
        open_fixture(context, page)

        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)

        assert len(requests_seen) >= 2, requests_seen
        first = requests_seen[0]
        first_query = parse_qs(urlparse(first["url"]).query)
        assert first_query["category"] == ["inference"]
        assert first_query["limit"] == ["50"]
        assert first["headers"].get("x-org-id") == WORKSPACE
        assert any("cursor=page-2" in seen["url"] for seen in requests_seen)

        before_cached_sync = len(requests_seen)
        page.get_by_text("立即同步", exact=True).first.click()
        page.locator('.ocgo-toast').filter(has_text="已是最新，没有新数据").wait_for(timeout=10000)
        assert len(requests_seen) == before_cached_sync + 1, requests_seen[before_cached_sync:]
        page.wait_for_timeout(300)
        panel_box = page.locator('.ocgo-panel').bounding_box()
        toast_box = page.locator('.ocgo-toast').bounding_box()
        assert panel_box is not None and toast_box is not None
        assert abs((toast_box["x"] + toast_box["width"] / 2) - (panel_box["x"] + panel_box["width"] / 2)) < 2
        assert toast_box["y"] - panel_box["y"] < 80
        assert toast_box["width"] <= 300
        assert pricing_seen, "Go pricing document should be fetched on first use"
        pricing_fetch_count = len(pricing_seen)

        tooltip = page.locator('.ocgo-chart-tooltip')
        metric_cells = page.locator('[data-view="overview"] .ocgo-metric-hover')
        assert metric_cells.count() == 2
        metric_cells.nth(0).hover()
        tooltip.wait_for(state="visible", timeout=5000)
        token_metric_text = tooltip.inner_text()
        assert "总 Token" in token_metric_text
        assert "缓存读取" in token_metric_text
        assert "4,020" in token_metric_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)
        metric_cells.nth(1).hover()
        tooltip.wait_for(state="visible", timeout=5000)
        cost_metric_text = tooltip.inner_text()
        assert "输入费用" in cost_metric_text
        assert "输出费用" in cost_metric_text
        assert "估算" in cost_metric_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)

        panel_background = page.locator('.ocgo-panel').evaluate("element => getComputedStyle(element).backgroundColor")
        assert panel_background == "rgb(22, 22, 22)"
        assert page.locator('.ocgo-body').evaluate("element => getComputedStyle(element).scrollbarWidth") == "thin"

        page.locator('[data-tab="charts"]').click()
        page.wait_for_selector("svg.ocgo-chart-svg", timeout=5000)
        assert page.locator("svg.ocgo-chart-svg").count() >= 4
        overview_cards = page.locator('[data-view="overview"] .ocgo-card')
        assert overview_cards.locator('.ocgo-card-label').all_text_contents() == [
            "请求",
            "费用",
            "输入 Token",
            "输出 Token",
            "TTFT（平均 / 最慢）",
            "输出 TPS（平均 / 最慢）",
            "缓存读取",
            "缓存命中率",
        ]
        assert overview_cards.filter(has_text="缓存写入").count() == 0
        for index in (2, 3, 6, 7):
            assert overview_cards.nth(index).locator('.ocgo-card-sub').count() == 0
        assert "Token/s" in overview_cards.nth(5).locator('.ocgo-card-value').inner_text()
        assert "Token/s" not in overview_cards.nth(5).locator('.ocgo-card-sub').inner_text()
        assert "TTFT 平均" in page.locator('[data-view="charts"] th').all_inner_texts()
        assert "TPS 平均" in page.locator('[data-view="charts"] th').all_inner_texts()
        assert page.locator('[data-view="charts"] th').filter(has_text="总 Token").count() == 1
        assert page.locator('[data-view="overview"] th').filter(has_text="总 Token").count() == 1
        assert "4.0k" in page.locator('[data-view="charts"] tbody tr').first.text_content()
        assert "4.0k" in page.locator('[data-view="overview"] tbody tr').first.text_content()
        averages = page.locator('[data-view="charts"] .ocgo-section-average')
        assert averages.count() == 4
        assert all(averages.nth(index).inner_text() for index in range(4))
        assert all("p50" not in averages.nth(index).inner_text().lower() for index in range(4))

        def chart_hosts_have_no_scroll() -> None:
            metrics = page.locator('[data-view="charts"] .ocgo-chart-host').evaluate_all(
                "elements => elements.map((element) => ({"
                "scrollHeight: element.scrollHeight, "
                "clientHeight: element.clientHeight, "
                "overflowY: getComputedStyle(element).overflowY"
                "}))"
            )
            assert all(item["scrollHeight"] <= item["clientHeight"] + 1 for item in metrics), metrics
            assert all(item["overflowY"] not in ("auto", "scroll") for item in metrics), metrics

        chart_hosts_have_no_scroll()
        page.get_by_label("放大图表").click()
        zoom_value = page.locator('.ocgo-zoom-value')
        zoom_value.filter(has_text="125%").wait_for(timeout=5000)
        assert "ocgo-chart-zoomed" in page.locator('.ocgo-chart-grid').get_attribute("class")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".ocgo-panel", state="visible", timeout=15000)
        zoom_value = page.locator('.ocgo-zoom-value')
        zoom_value.filter(has_text="125%").wait_for(timeout=5000)
        zoom_value.click()
        zoom_value.filter(has_text="100%").wait_for(timeout=5000)
        for _ in range(2):
            page.get_by_label("缩小图表").click()
        zoom_value.filter(has_text="50%").wait_for(timeout=5000)
        assert page.get_by_label("缩小图表").is_disabled()
        for _ in range(6):
            page.get_by_label("放大图表").click()
        zoom_value.filter(has_text="200%").wait_for(timeout=5000)
        assert page.get_by_label("放大图表").is_disabled()
        chart_hosts_have_no_scroll()
        zoom_value.click()
        zoom_value.filter(has_text="100%").wait_for(timeout=5000)

        def hover_chart(index: int) -> str:
            chart = page.locator('[data-view="charts"] .ocgo-chart-box').nth(index)
            target = chart.locator('.ocgo-hover-target').last
            target.scroll_into_view_if_needed()
            target.hover()
            tooltip.wait_for(state="visible", timeout=5000)
            text = tooltip.inner_text()
            page.mouse.move(5, 5)
            tooltip.wait_for(state="hidden", timeout=5000)
            return text

        token_tooltip = hover_chart(0)
        assert "总 Token" in token_tooltip
        assert "输入" in token_tooltip
        assert "缓存读取" in token_tooltip
        assert "缓存写入" in token_tooltip
        assert "输出" in token_tooltip
        assert "4,020" in token_tooltip
        assert "TTFT" not in token_tooltip
        assert "TPS" not in token_tooltip
        assert "命中率" not in token_tooltip

        cache_tooltip = hover_chart(1)
        assert "命中率" in cache_tooltip
        assert "缓存读取" in cache_tooltip
        assert "缓存写入" in cache_tooltip
        assert "TTFT" not in cache_tooltip
        assert "TPS" not in cache_tooltip
        assert "总 Token" not in cache_tooltip
        assert "输入" not in cache_tooltip
        assert "输出" not in cache_tooltip

        ttft_tooltip = hover_chart(2)
        assert "TTFT 平均" in ttft_tooltip
        assert "TTFT 最慢" in ttft_tooltip
        assert "TTFT 样本" in ttft_tooltip
        assert "TPS" not in ttft_tooltip
        assert "总 Token" not in ttft_tooltip
        assert "命中率" not in ttft_tooltip

        tps_tooltip = hover_chart(3)
        assert "TPS 平均" in tps_tooltip
        assert "TPS 最慢" in tps_tooltip
        assert "TPS 样本" in tps_tooltip
        assert "TTFT" not in tps_tooltip
        assert "总 Token" not in tps_tooltip
        assert "命中率" not in tps_tooltip

        token_target = page.locator('[data-view="charts"] .ocgo-chart-box').first.locator('.ocgo-hover-target').last
        token_target.focus()
        tooltip.wait_for(state="visible", timeout=5000)
        aria_label = token_target.get_attribute("aria-label") or ""
        assert "TTFT" not in aria_label
        assert "TPS" not in aria_label
        token_target.evaluate("element => element.blur()")
        tooltip.wait_for(state="hidden", timeout=5000)

        page.locator('[data-tab="requests"]').click()
        rows = page.locator('[data-view="requests"] .ocgo-table tbody tr')
        assert rows.count() == 3, rows.count()
        assert page.get_by_text("Token/s", exact=False).count() >= 1
        page.locator('[data-view="requests"]').get_by_text("Alice", exact=True).first.wait_for(timeout=5000)
        page.locator('[data-view="requests"] tbody a').first.click()
        page.wait_for_selector('.ocgo-panel', state='hidden', timeout=5000)
        page.locator('.ocgo-fab').click()
        page.wait_for_selector('.ocgo-panel', state='visible', timeout=5000)

        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('.ocgo-panel', state='visible', timeout=15000)
        page.wait_for_timeout(300)
        assert len(pricing_seen) == pricing_fetch_count, pricing_seen

        page.locator('[data-tab="data"]').click()
        pricing_section = page.locator('.ocgo-pricing-section')
        pricing_section.wait_for(state='visible', timeout=5000)
        pricing_text = pricing_section.inner_text()
        assert "模型价格缓存" in pricing_text
        assert "DeepSeek V4.1 Flash" in pricing_text
        assert "$0.30" in pricing_text
        assert pricing_section.locator('tbody tr').count() == 2
        pricing_box = pricing_section.bounding_box()
        logs_box = page.locator('.ocgo-log-list').bounding_box()
        assert pricing_box is not None and logs_box is not None
        assert pricing_box["y"] < logs_box["y"]
        with page.expect_download(timeout=10000) as download_info:
            page.get_by_text("导出筛选明细 CSV", exact=True).click()
        assert download_info.value.suggested_filename.endswith(".csv")

        page.get_by_text("清空本地历史", exact=True).click()
        page.get_by_text("再次点击确认清空", exact=True).click()
        page.locator(".ocgo-statusbar").filter(has_text="0 条本地记录").wait_for(timeout=5000)

        assert not errors, errors
        browser.close()


def test_fab_and_resize_interactions():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen)
        open_fixture(context, page, open_panel=False)

        fab = page.locator('.ocgo-fab')
        panel = page.locator('.ocgo-panel')
        fab.click()
        panel.wait_for(state="visible", timeout=5000)
        assert fab.get_attribute("aria-expanded") == "true"
        fab.click()
        panel.wait_for(state="hidden", timeout=5000)
        assert fab.get_attribute("aria-expanded") == "false"

        before_drag = fab.bounding_box()
        assert before_drag is not None
        page.mouse.move(before_drag["x"] + 24, before_drag["y"] + 24)
        page.mouse.down()
        page.mouse.move(before_drag["x"] - 56, before_drag["y"] - 36, steps=6)
        page.mouse.up()
        after_drag = fab.bounding_box()
        assert after_drag is not None
        assert after_drag["x"] < before_drag["x"]
        assert after_drag["y"] < before_drag["y"]
        assert panel.is_hidden()
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector(".ocgo-panel", state="hidden", timeout=15000)
        restored_fab = page.locator('.ocgo-fab').bounding_box()
        assert restored_fab is not None
        assert abs(restored_fab["x"] - after_drag["x"]) < 2
        assert abs(restored_fab["y"] - after_drag["y"]) < 2
        page.wait_for_timeout(400)

        fab.click()
        panel.wait_for(state="visible", timeout=5000)
        page.mouse.click(10, 10)
        panel.wait_for(state="hidden", timeout=5000)
        fab.click()
        panel.wait_for(state="visible", timeout=5000)
        page.keyboard.press("Escape")
        panel.wait_for(state="hidden", timeout=5000)

        fab.click()
        panel.wait_for(state="visible", timeout=5000)
        handles = page.locator('.ocgo-resize-handle')
        assert handles.count() == 8
        panel_before = panel.bounding_box()
        west = page.locator('[data-resize="w"]').bounding_box()
        assert panel_before is not None and west is not None
        page.mouse.move(west["x"] + west["width"] / 2, west["y"] + west["height"] / 2)
        page.mouse.down()
        page.mouse.move(west["x"] - 36, west["y"] + west["height"] / 2, steps=5)
        page.mouse.up()
        panel_after = panel.bounding_box()
        assert panel_after is not None
        assert panel_after["x"] < panel_before["x"]
        assert panel_after["width"] > panel_before["width"]
        assert not errors, errors
        browser.close()


def test_workspace_route_change():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen)
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)

        page.evaluate(f"history.pushState({{}}, '', '/console/{SECOND_WORKSPACE}')")
        page.get_by_text("Second", exact=True).wait_for(timeout=10000)
        page.locator(".ocgo-statusbar").filter(has_text="3 条本地记录").wait_for(timeout=15000)
        assert any(seen["headers"].get("x-org-id") == SECOND_WORKSPACE for seen in requests_seen)
        assert not errors, errors
        browser.close()


def test_rate_limit_retry():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, rate_limit_once=True)
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)
        assert len(requests_seen) >= 3
        assert not errors, errors
        browser.close()


def test_session_error():
    requests_seen = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        install_routes(page, requests_seen, unauthorized=True)
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.locator(".ocgo-error").filter(has_text="登录已失效").wait_for(timeout=10000)
        browser.close()


def test_english_browser_locale():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(locale="en-US")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen)
        open_fixture(context, page, language=None)

        page.get_by_text("Sync now", exact=True).first.wait_for(timeout=5000)
        page.get_by_text("Overview", exact=True).wait_for(timeout=5000)
        page.get_by_text("Sync now", exact=True).first.click()
        page.locator(".ocgo-statusbar").filter(has_text="3 local records").wait_for(timeout=15000)
        page.locator('[data-tab="data"]').click()
        levels = page.locator('.ocgo-log-level').all_text_contents()
        assert levels and all(level in {"Info", "Warning", "Error"} for level in levels), levels
        messages = page.locator('.ocgo-log-msg').all_text_contents()
        assert any("sync" in message.lower() or "mounted" in message.lower() for message in messages), messages
        assert not errors, errors
        browser.close()


def test_overview_cache_write_card():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, cache_write=125)
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)

        cards = page.locator('[data-view="overview"] .ocgo-card')
        labels = cards.locator('.ocgo-card-label').all_text_contents()
        assert labels == [
            "请求",
            "费用",
            "输入 Token",
            "输出 Token",
            "TTFT（平均 / 最慢）",
            "输出 TPS（平均 / 最慢）",
            "缓存写入",
            "缓存读取",
            "缓存命中率",
        ], labels
        assert cards.nth(6).locator('.ocgo-card-value').inner_text() == "375"
        assert cards.nth(6).locator('.ocgo-card-sub').count() == 0
        assert not errors, errors
        browser.close()


def test_model_tables_hide_zero_token_models():
    requests_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, zero_token_model="empty-model")
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.locator(".ocgo-statusbar").filter(has_text="4 条本地记录").wait_for(timeout=15000)

        for tab, view in (("overview", "overview"), ("charts", "charts")):
            page.locator(f'[data-tab="{tab}"]').click()
            rows = page.locator(f'[data-view="{view}"] tbody tr')
            rows.first.wait_for(timeout=5000)
            assert rows.count() == 1, rows.all_inner_texts()
            text = rows.first.inner_text()
            assert "deepseek-v4.1-flash" in text
            assert "empty-model" not in text

        assert not errors, errors
        browser.close()


def test_forecast_beta_toggle():
    requests_seen = []
    status_seen = []
    pricing_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, pricing_seen=pricing_seen, status_seen=status_seen)
        open_fixture(context, page)

        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)
        forecast_tab = page.locator('[data-tab="forecast"]')
        assert forecast_tab.is_hidden()
        assert page.locator('[data-view="overview"]').is_visible()
        overview_forecast = page.locator('[data-view="overview"] [data-overview-forecast]')
        assert overview_forecast.is_hidden()
        assert not status_seen, status_seen

        page.locator('[data-tab="data"]').click()
        toggle = page.locator('.ocgo-experimental-row input')
        toggle.check()
        assert forecast_tab.is_visible()
        assert "Beta" in forecast_tab.inner_text()
        tab_order = page.locator('[data-tab]').evaluate_all("elements => elements.map(element => element.dataset.tab)")
        assert tab_order == ["overview", "charts", "forecast", "requests", "data"]
        assert not status_seen, status_seen

        page.locator('[data-tab="overview"]').click()
        overview_forecast.wait_for(state="visible", timeout=15000)
        overview_forecast.locator(".ocgo-forecast-card").first.wait_for(timeout=15000)
        assert overview_forecast.locator(".ocgo-forecast-card").count() == 4
        overview_table = page.locator('[data-view="overview"] tbody').first
        overview_table.wait_for(state="visible", timeout=5000)
        assert overview_forecast.evaluate("""element => {
            const table = element.nextElementSibling?.querySelector('tbody');
            return Boolean(table) && element.getBoundingClientRect().top < table.getBoundingClientRect().top;
        }""")

        forecast_tab.click()
        cards = page.locator('[data-view="forecast"] .ocgo-forecast-card')
        cards.first.wait_for(timeout=15000)
        assert cards.count() == 4
        assert cards.locator(".ocgo-card-label").all_inner_texts() == [
            "到 5 小时重置时预计累计用量",
            "未来 24 小时预计新增用量",
            "到每周重置时预计累计用量",
            "到每月重置时预计累计用量",
        ]
        assert status_seen and "x-org-id" in status_seen[0]["headers"]
        assert status_seen[0]["headers"]["x-org-id"] == WORKSPACE
        headers = page.locator('[data-view="forecast"] .ocgo-forecast-table thead th').all_inner_texts()
        assert headers == ["模型", "每月上限", "5 小时已用/上限", "每周已用/上限", "每月已用/上限"]
        rows = page.locator('[data-view="forecast"] .ocgo-forecast-table tbody tr')
        assert rows.count() == 1, rows.all_inner_texts()
        deepseek = page.locator('[data-view="forecast"] tr[data-model="deepseek-v4.1-flash"]')
        assert deepseek.locator("td").count() == 5
        assert "$80.00" in deepseek.locator("td").nth(1).inner_text()
        assert "$16.00" in (deepseek.locator("td").nth(2).get_attribute("title") or "")
        assert "$40.00" in (deepseek.locator("td").nth(3).get_attribute("title") or "")
        assert page.locator('[data-view="forecast"] svg.ocgo-forecast-chart').count() == 1
        tooltip = page.locator(".ocgo-chart-tooltip")
        window_labels = [
            "5 小时",
            "未来 24 小时",
            "每周",
            "每月",
        ]
        for index, label in enumerate(window_labels):
            page.mouse.move(5, 5)
            tooltip.wait_for(state="hidden", timeout=5000)
            cards.locator(".ocgo-card-value").nth(index).hover()
            tooltip.wait_for(state="visible", timeout=5000)
            tooltip_text = tooltip.inner_text()
            assert "预计（p50）" in tooltip_text
            assert label in tooltip_text, (index, label, tooltip_text)
            arrival_note = tooltip.locator(".ocgo-tooltip-note").inner_text()
            assert arrival_note.startswith("届时月额度消耗累计约 ")
            assert arrival_note.endswith("%")
            if index == 1:
                assert "预测终点" in tooltip_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)
        page.locator('[data-view="forecast"] .ocgo-info-btn').hover()
        tooltip.wait_for(state="visible", timeout=5000)
        info_text = tooltip.inner_text()
        assert "如何阅读用量预测" in info_text
        assert "15 分钟" in info_text
        assert "时间虚线" in info_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)
        legend_text = page.locator('[data-view="forecast"] .ocgo-forecast-chart-legend').inner_text()
        assert "历史累计" in legend_text
        assert "预测 p50" in legend_text
        assert "p10–p90 区间" in legend_text
        assert "当前时刻" in legend_text
        assert "限额重置（5 小时 / 每周 / 每月）" in legend_text
        tightest = page.locator('[data-view="forecast"] .ocgo-forecast-help')
        assert tightest.is_visible()
        tightest.hover()
        tooltip.wait_for(state="visible", timeout=5000)
        tightest_text = tooltip.inner_text()
        assert "什么是“风险最高模型”" in tightest_text
        assert "最高 p90" in tightest_text
        assert "风险分最高" in tightest_text
        assert "p90" in tightest_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)
        chart_targets = page.locator('[data-view="forecast"] .ocgo-forecast-hover-target')
        assert chart_targets.count() > 0
        chart_targets.last.hover()
        tooltip.wait_for(state="visible", timeout=5000)
        chart_text = tooltip.inner_text()
        assert "预测中位数（p50）" in chart_text
        assert "预测上界（p90）" in chart_text
        page.mouse.move(5, 5)
        tooltip.wait_for(state="hidden", timeout=5000)
        deepseek.click()
        page.wait_for_timeout(100)
        assert page.locator('[data-view="forecast"] .ocgo-forecast-row.ocgo-active').get_attribute("data-model") == "deepseek-v4.1-flash"

        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('.ocgo-panel', state='visible', timeout=15000)
        assert forecast_tab.is_visible()
        assert page.locator('[data-view="forecast"]').is_visible()
        page.locator('[data-tab="data"]').click()
        assert page.locator('.ocgo-experimental-row input').is_checked()

        page.locator('.ocgo-experimental-row input').uncheck()
        assert forecast_tab.is_hidden()
        assert page.locator('[data-view="data"]').is_visible()
        assert not errors, errors
        browser.close()


def test_forecast_refresh_keeps_view():
    requests_seen = []
    status_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, status_seen=status_seen, log_delay_ms=350)
        open_fixture(context, page)

        sync_button = page.get_by_text("立即同步", exact=True).first
        sync_button.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)
        page.locator('[data-tab="data"]').click()
        page.locator('.ocgo-experimental-row input').check()
        page.locator('[data-tab="forecast"]').click()
        page.locator('[data-view="forecast"] .ocgo-forecast-card').first.wait_for(timeout=15000)
        page.locator('[data-view="forecast"] .ocgo-forecast-window-btn').filter(has_text="每周").click()
        assert page.locator('[data-view="forecast"] .ocgo-forecast-window-btn.ocgo-active').inner_text() == "每周"

        page.evaluate("""() => {
          const view = document.getElementById('ocgo-lens-host').shadowRoot.querySelector('[data-view="forecast"]');
          window.__forecastRefreshSnapshots = [];
          const capture = () => {
            const root = view.querySelector('.ocgo-forecast-view');
            window.__forecastRefreshSnapshots.push({
              cards: view.querySelectorAll('.ocgo-forecast-card').length,
              charts: view.querySelectorAll('svg.ocgo-forecast-chart').length,
              busy: root?.getAttribute('aria-busy') || 'false',
              text: view.innerText,
            });
          };
          capture();
          window.__forecastRefreshObserver = new MutationObserver(capture);
          window.__forecastRefreshObserver.observe(view, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['aria-busy', 'data-refreshing'],
          });
        }""")

        sync_button = page.get_by_text("立即同步", exact=True).first
        sync_button.click()
        page.wait_for_function(
            "() => [...document.getElementById('ocgo-lens-host').shadowRoot.querySelectorAll('.ocgo-sync-btn')].some((button) => button.textContent?.trim() === '停止')",
            timeout=5000,
        )
        page.wait_for_function(
            "() => !document.getElementById('ocgo-lens-host').shadowRoot.querySelector('[data-view=\"forecast\"] .ocgo-forecast-view[data-refreshing]')",
            timeout=15000,
        )
        page.wait_for_function(
            "() => window.__forecastRefreshSnapshots.some((item) => item.busy === 'true')",
            timeout=5000,
        )
        page.wait_for_timeout(150)

        snapshots = page.evaluate("window.__forecastRefreshSnapshots")
        assert snapshots, snapshots
        assert all(item["cards"] == 4 for item in snapshots), snapshots
        assert all(item["charts"] == 1 for item in snapshots), snapshots
        assert all("正在计算用量预测" not in item["text"] for item in snapshots), snapshots
        assert page.locator('[data-view="forecast"] .ocgo-forecast-window-btn.ocgo-active').inner_text() == "每周"
        assert not errors, errors
        browser.close()



def test_forecast_status_fallback():
    requests_seen = []
    status_seen = []
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page, requests_seen, status_seen=status_seen, status_unauthorized=True)
        open_fixture(context, page)
        page.get_by_text("立即同步", exact=True).first.click()
        page.get_by_text("3", exact=True).first.wait_for(timeout=15000)
        page.locator('[data-tab="data"]').click()
        page.locator('.ocgo-experimental-row input').check()
        page.locator('[data-tab="forecast"]').click()
        page.locator('[data-view="forecast"] .ocgo-forecast-card').first.wait_for(timeout=15000)
        assert page.locator('[data-view="forecast"] .ocgo-forecast-card').count() == 4
        assert status_seen
        assert page.locator('[data-view="forecast"] .ocgo-warning').filter(has_text="Go 状态请求失败").count() == 1
        assert not errors, errors
        browser.close()


def capture_readme_screenshots():
    output_dir = Path(__file__).resolve().parent.parent / "image" / "README"
    output_dir.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for language in ("zh", "en"):
            suffix = "zh-CN" if language == "zh" else "en"
            context = browser.new_context(
                viewport={"width": 1360, "height": 1040},
                reduced_motion="reduce",
            )
            context.add_init_script("""
              localStorage.setItem('ocgo-lens:panelState', JSON.stringify({
                open: true, width: 1200, height: 920, x: 40, y: 24
              }));
              localStorage.setItem('ocgo-lens:experimentalForecast', JSON.stringify(true));
            """)
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            install_routes(page, [], pricing_seen=[], status_seen=[])
            open_fixture(context, page, language=language)
            page.locator('.ocgo-sync-btn').click()
            page.locator('.ocgo-statusbar').filter(has_text='3').wait_for(timeout=15000)
            page.locator('[data-view="overview"] .ocgo-forecast-card').first.wait_for(timeout=15000)
            page.locator('.ocgo-toast').wait_for(state='hidden', timeout=6000)
            page.locator('#ocgo-lens-panel').screenshot(
                path=str(output_dir / f'overview.{suffix}.png'),
            )

            page.locator('[data-tab="charts"]').click()
            page.wait_for_timeout(250)
            page.locator('#ocgo-lens-panel').screenshot(
                path=str(output_dir / f'charts.{suffix}.png'),
            )

            page.locator('[data-tab="forecast"]').click()
            page.locator('[data-view="forecast"] .ocgo-forecast-card').first.wait_for(timeout=15000)
            page.wait_for_timeout(250)
            page.locator('#ocgo-lens-panel').screenshot(
                path=str(output_dir / f'usage-forecast.{suffix}.png'),
            )
            context.close()
        browser.close()
    if errors:
        raise RuntimeError(errors)
    print(f'Wrote README screenshots to {output_dir}')



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-readme", action="store_true")
    args = parser.parse_args()
    if args.capture_readme:
        capture_readme_screenshots()
    else:
        test_main_flow()
        test_range_presets()
        test_english_browser_locale()
        test_overview_cache_write_card()
        test_model_tables_hide_zero_token_models()
        test_forecast_beta_toggle()
        test_forecast_refresh_keeps_view()
        test_forecast_status_fallback()
        test_fab_and_resize_interactions()
        test_workspace_route_change()
        test_rate_limit_retry()
        test_session_error()
        print("userscript e2e tests OK")
