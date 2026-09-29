"""Real Chromium workflows against an isolated, disposable loopback fixture.

Install the optional requirements-browser.txt into a separate environment.
Set ASTRA_BROWSER_EXECUTABLE to an existing Chromium, or install Playwright's
Chromium. Pass a NEW evidence directory; existing evidence is never overwritten.
"""
from pathlib import Path
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from playwright.sync_api import sync_playwright, expect

expect.set_options(timeout=20000)

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=False)
results = []
screens = []
started = time.time()


def passed(name):
    results.append({"name": name, "passed": True})
    print(f"PASS {name}", flush=True)


def screenshot(page, name):
    page.screenshot(path=str(OUT / f"{name}.png"), full_page=True)
    screens.append(f"{name}.png")


def run(page, url, tokens):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: dialog.accept())
    page.goto(url)
    expect(page.locator("#login-panel")).to_be_visible()
    expect(page.locator("#workspace")).to_be_hidden()
    assert page.evaluate("localStorage.length") == 0
    passed("explicit sign-in without persisted credentials")

    def login(role):
        page.locator("#login-token").fill(tokens[role])
        page.locator("#login-form button").click()
        expect(page.locator("#workspace")).to_be_visible()
        expect(page.locator("#refresh")).to_be_enabled()

    def kind(value):
        page.locator("#resource-kind").select_option(value)
        expect(page.locator("#editor-title")).to_contain_text("New")

    def saved():
        expect(page.locator("#flash")).to_contain_text("Saved.")
        expect(page.locator("#refresh")).to_be_enabled()

    def save():
        page.locator("#save-record").click()
        saved()

    def snapshot():
        response = page.request.get(url + "/api/admin/bootstrap", headers={"Authorization": f"Bearer {tokens['admin']}"})
        assert response.status == 200
        return response.json()

    def external_patch(resource, record_id, body):
        data = snapshot()
        response = page.request.patch(url + f"/api/admin/{resource}/{record_id}", data=body,
                                     headers={"Authorization": f"Bearer {tokens['admin']}", "If-Match": f'"{data["revision"]}"'})
        assert response.status == 200, response.text()
        return response.json()

    login("admin")
    expect(page.locator("#record-list button")).to_have_count(20)
    page.locator("#next").click()
    expect(page.locator("#page-label")).to_contain_text("Page 2")
    page.locator("#search").fill("paging_23")
    expect(page.locator("#record-list button")).to_have_count(1)
    page.locator("#search").fill("")
    passed("search and bounded list pagination")
    screenshot(page, "01-desktop")

    page.locator("#field-name").fill('<img src=x onerror="window.injected=true">')
    page.locator("#field-key").fill("browser_crud")
    page.locator("#field-description").fill("Original description")
    save()
    created = next(flag for flag in snapshot()["flags"] if flag["key"] == "browser_crud")
    expect(page.locator("#editor-title")).to_contain_text("<img")
    assert page.locator("#record-list img").count() == 0
    assert page.evaluate("window.injected === undefined")
    passed("flag creation renders hostile text literally")

    page.locator("#field-name").fill("My retained name")
    external_patch("flags", created["id"], {"description": "Another editor's accepted description"})
    page.locator("#save-record").click()
    expect(page.locator("#save-record")).to_be_disabled()
    expect(page.locator("#field-name")).to_have_value("My retained name")
    page.locator("#review-latest").click()
    expect(page.locator("#review-panel")).to_be_visible()
    expect(page.locator("#accept-review")).to_be_enabled()
    screenshot(page, "02-conflict-review")
    page.locator("#accept-review").click()
    expect(page.locator("#field-description")).to_have_value("Another editor's accepted description")
    expect(page.locator("#field-name")).to_have_value("My retained name")
    save()
    passed("stale writes preserve changed fields and refresh unedited fields")

    page.locator("#search").fill("checkout_redesign")
    page.locator("#record-list button").click()
    page.locator("#field-description").fill("Protected change reviewed")
    expect(page.locator("#save-record")).to_be_disabled()
    page.locator("#protected-ack").check()
    expect(page.locator("#protected-ack")).to_be_checked()
    expect(page.locator("#save-record")).to_be_enabled()
    page.locator("#field-description").fill("Protected change revised")
    expect(page.locator("#protected-ack")).not_to_be_checked()
    page.locator("#protected-ack").check()
    save()
    passed("protected changes require acknowledgment of the current draft")

    kind("environments")
    page.locator("#field-name").fill("Browser sandbox")
    page.locator("#field-key").fill("browser_sandbox")
    save()
    page.locator("#field-name").fill("Renamed sandbox")
    save()
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    passed("environment create edit and reference-safe delete")

    kind("projects")
    page.locator("#field-name").fill("Browser project")
    page.locator("#field-key").fill("browser_project")
    save()
    page.locator("#field-description").fill("A disposable project")
    save()
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    passed("project create edit and delete")

    kind("segments")
    page.locator("#field-name").fill("Browser segment")
    page.locator("#field-constraints").fill('[{"field":"plan","operator":"in","values":["pro"]}]')
    save()
    segment_id = next(item["id"] for item in snapshot()["segments"] if item["name"] == "Browser segment")
    page.locator("#field-description").fill("Learner-owned cohort")
    save()
    passed("segment create and edit typed constraints")

    kind("strategies")
    page.locator("#field-name").fill("Browser strategy")
    page.locator("#field-flagId").select_option(created["id"])
    page.locator("#field-type").select_option("enabled_for_all")
    page.locator("#field-segmentIds").select_option(segment_id)
    page.locator("#field-parameters").fill("{broken")
    page.locator("#save-record").click()
    expect(page.locator("#flash")).to_contain_text("must contain valid JSON")
    expect(page.locator("#field-name")).to_have_value("Browser strategy")
    page.locator("#field-parameters").fill("{}")
    passed("invalid JSON reports the field and preserves the draft")
    save()
    strategy_id = next(item["id"] for flag in snapshot()["flags"] for item in flag["strategies"] if item["name"] == "Browser strategy")
    page.locator("#field-sortOrder").fill("2")
    save()
    passed("strategy create edit and scoped segment reference")

    kind("variants")
    page.locator("#field-name").fill("control")
    page.locator("#field-strategyId").select_option(strategy_id)
    expect(page.locator("#field-weight")).to_have_value("100")
    page.locator("#field-payload").fill("Original text")
    save()
    page.locator("#field-payloadType").select_option("json")
    page.locator("#field-payload").fill('{"theme":"calm"}')
    save()
    screenshot(page, "03-variant-editor")
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    passed("variant defaults typed JSON payload update and delete")

    kind("dependencies")
    other = next(flag for flag in snapshot()["flags"] if flag["key"] == "paging_1")
    page.locator("#field-parentFlagId").select_option(other["id"])
    page.locator("#field-childFlagId").select_option(created["id"])
    save()
    expect(page.locator("#save-record")).to_be_disabled()
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    passed("dependency creation immutable review and removal")

    kind("tokens")
    page.locator("#field-name").fill("Browser evaluation token")
    save()
    expect(page.locator("#new-token-panel")).to_be_visible()
    assert len(page.locator("#new-token-value").inner_text()) >= 32
    page.locator("#dismiss-token").click()
    expect(page.locator("#new-token-value")).to_have_text("")
    page.locator("#delete-record").click()
    saved()
    expect(page.locator("#delete-record")).to_be_disabled()
    passed("one-time token display dismissal and revocation")

    kind("flags")
    page.locator("#field-name").fill("Uncertain creation")
    page.locator("#field-key").fill("uncertain_creation")
    requests = []
    def lose_response(route):
        if route.request.method == "POST":
            requests.append(route.request.method)
            accepted = route.fetch()
            assert accepted.status == 201
            route.abort("failed")
        else:
            route.continue_()
    page.route("**/api/admin/flags", lose_response)
    page.locator("#save-record").click()
    expect(page.locator("#flash")).to_contain_text("may have accepted")
    expect(page.locator("#save-record")).to_be_disabled()
    assert requests == ["POST"]
    assert sum(flag["key"] == "uncertain_creation" for flag in snapshot()["flags"]) == 1
    page.unroute("**/api/admin/flags", lose_response)
    page.locator("#review-latest").click()
    expect(page.locator("#review-panel")).to_be_visible()
    expect(page.locator("#accept-review")).to_be_enabled()
    expect(page.locator("#review-message")).to_contain_text("already accepted creation")
    passed("lost creation response blocks automatic retry and retains draft")

    page.locator("#discard-draft").click()
    page.locator("#search").fill("paging_2")
    page.locator("#record-list button").first.click()
    page.locator("#field-description").fill("Draft after server error")
    def server_error(route):
        route.fulfill(status=500, content_type="application/json", body='{"error":"Operation failed"}')
    page.route("**/api/admin/flags/*", server_error)
    page.locator("#save-record").click()
    expect(page.locator("#flash")).to_contain_text("may have been accepted")
    expect(page.locator("#save-record")).to_be_disabled()
    expect(page.locator("#field-description")).to_have_value("Draft after server error")
    page.unroute("**/api/admin/flags/*", server_error)
    page.locator("#review-latest").click()
    expect(page.locator("#accept-review")).to_be_enabled()
    page.locator("#accept-review").click()
    save()
    passed("server write errors require review before a retained edit can retry")

    page.locator("#search").fill("browser_crud")
    page.locator("#record-list button").click()
    page.locator("#field-archived").check()
    save()
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    assert all(flag["id"] != created["id"] for flag in snapshot()["flags"])
    kind("segments")
    page.locator("#search").fill("Browser segment")
    page.locator("#record-list button").click()
    page.locator("#delete-record").click()
    expect(page.locator("#flash")).to_contain_text("Record deleted")
    expect(page.locator("#refresh")).to_be_enabled()
    passed("archived flag deletion cascades owned strategy and releases segment")

    page.locator("#playground-form button").click()
    expect(page.locator("#flash")).to_contain_text("Context evaluated")
    assert page.locator("#playground-result").inner_text().startswith("[")
    passed("context playground evaluates accepted configuration")

    page.locator("#sign-out").click()
    login("member")
    kind("flags")
    page.locator("#field-name").fill("Member flag")
    page.locator("#field-key").fill("member_flag")
    save()
    kind("variants")
    expect(page.locator("#save-record")).to_be_enabled()
    kind("projects")
    expect(page.locator("#new-record")).to_be_disabled()
    expect(page.locator("#save-record")).to_be_disabled()
    passed("member permissions allow scoped writes and deny global creation")
    page.locator("#sign-out").click()
    login("viewer")
    kind("flags")
    expect(page.locator("#save-record")).to_be_disabled()
    page.locator("#record-list button").first.click()
    expect(page.locator("#delete-record")).to_be_disabled()
    passed("viewer can inspect without mutation controls")
    screenshot(page, "04-viewer")

    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    screenshot(page, "05-mobile")
    page.locator("#sign-out").click()
    expect(page.locator("#login-panel")).to_be_visible()
    assert page.evaluate("localStorage.length") == 0
    assert errors == [], errors
    passed("mobile layout sign-out and no uncaught browser errors")


exit_code = 1
directory = Path(tempfile.mkdtemp(prefix="feature-flags-browser-"))
process = None
try:
    env = {**os.environ, "BROWSER_FIXTURE_STATE_PATH": str(directory / "state.json")}
    with (OUT / "server.log").open("w", encoding="utf-8") as error_log:
        process = subprocess.Popen(["node", "verification/browser-fixture.js"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=error_log, text=True, encoding="utf-8")
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
        fixture = json.loads(lines.get(timeout=120))
        with sync_playwright() as playwright:
            executable = os.environ.get("ASTRA_BROWSER_EXECUTABLE")
            browser = playwright.chromium.launch(**({"executable_path": executable} if executable else {}))
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.set_default_timeout(20000)
            try:
                run(page, fixture["url"], fixture["tokens"])
                exit_code = 0
            except Exception:
                screenshot(page, "failure")
                (OUT / "failure.txt").write_text(traceback.format_exc(), encoding="utf-8")
                raise
            finally:
                browser.close()
except Exception:
    traceback.print_exc()
finally:
    if process is not None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=20)
    assert directory.parent.resolve() == Path(tempfile.gettempdir()).resolve()
    assert directory.name.startswith("feature-flags-browser-")
    for item in directory.iterdir():
        assert item.is_file()
        item.unlink()
    directory.rmdir()
    (OUT / "results.json").write_text(json.dumps({"passed": exit_code == 0, "checks": results, "screenshots": screens, "seconds": round(time.time() - started, 2)}, indent=2), encoding="utf-8")
sys.exit(exit_code)
