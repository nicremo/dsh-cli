#!/usr/bin/env python3
"""dsho capture: deterministic screenshots and scroll videos with Playwright.

shot    viewport, full-page or element screenshot (PNG or JPEG by extension)
scroll  frame-stepped smooth scroll video: every frame is rendered at an exact
        scroll position, then ffmpeg encodes H.264. Slower than real-time
        recording, but sharp and free of dropped frames.

Uses Playwright's bundled Chromium, never the installed Google Chrome app.
Prints one JSON object on stdout.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, sync_playwright

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)

AD_HOSTS = (
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.",
    "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "teads.tv", "smartadserver.com", "adform.net", "rubiconproject.com", "pubmatic.com",
    "openx.net", "casalemedia.com", "yieldlab.net", "adsrvr.org", "3lift.com", "seedtag.com",
    "stroeer", "theadex.com", "permutive.com", "ad.71i.de", "adition.com",
)

# Host contains one of AD_HOSTS (same substring rule as the list above).
AD_PATTERN = re.compile(r"^https?://[^/]*(?:" + "|".join(re.escape(h) for h in AD_HOSTS) + ")")

CONSENT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "#didomi-notice-agree-button",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "[data-testid='uc-accept-all-button']",
    "button[data-testid='accept-all']",
    ".sp_choice_type_11",
    ".fc-cta-consent",
    "button.accept-all",
    "#accept-all",
    "button[title='Zustimmen']",
    "button[title='Alle akzeptieren']",
    "button[title='Accept']",
    "button[aria-label='Accept all']",
]

CONSENT_TEXTS = [
    "Alle akzeptieren",
    "Alles akzeptieren",
    "Alle Cookies akzeptieren",
    "Akzeptieren und weiter",
    "Zustimmen und weiter",
    "Akzeptieren",
    "Zustimmen",
    "Alle zulassen",
    "Einverstanden",
    "Accept all",
    "Accept All",
    "Accept all cookies",
    "Allow all",
    "I agree",
    "I Accept",
    "Agree",
    "Accept",
    "Got it",
    "OK",
]

# Fallback when clicking fails: hide common consent layers and unlock scrolling.
CONSENT_CSS = """
#onetrust-consent-sdk, #onetrust-banner-sdk, #usercentrics-root, #usercentrics-cmp-ui,
#didomi-host, #CybotCookiebotDialog, .sp_message_container, [id^='sp_message_container'],
.fc-consent-root, #cmpbox, #cmpbox2, .cmp-root, #qc-cmp2-container, .qc-cmp2-container,
#truste-consent-track, .truste_box_overlay, #cookie-banner, .cookie-banner, #cookiebanner,
.cookie-consent, #cookie-consent, [aria-label='Cookie banner'] { display: none !important; }
html, body { overflow: auto !important; position: static !important; }
"""

CLOSE_SELECTORS = [
    "[role='dialog'] [aria-label='Schließen']",
    "[role='dialog'] [aria-label='Close']",
    "[aria-modal='true'] [aria-label='Schließen']",
    "[aria-modal='true'] [aria-label='Close']",
    "button[aria-label='Schließen']",
    "button[aria-label='Close']",
    "button[aria-label='close']",
    "button[title='Schließen']",
    "button[title='Close']",
    "[data-testid*='close-button']",
]


# Hide fixed layers that cover the content (paywall teasers, newsletter and app
# prompts, chat widgets, modal backdrops). Top bars and app shells stay.
HIDE_OVERLAYS_JS = """
() => {
  const vh = innerHeight, vw = innerWidth;
  let hidden = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.top <= 5 && r.height < vh * 0.2) continue;
    if (el.querySelector('main, article') || (el.innerText || '').length > 6000) continue;
    const big = r.width * r.height > vw * vh * 0.04;
    const atBottom = r.bottom >= vh - 4 && r.height > 40;
    if (!big && !atBottom) continue;
    el.style.setProperty('display', 'none', 'important');
    hidden++;
  }
  for (const node of [document.documentElement, document.body]) node.style.setProperty('overflow', 'auto', 'important');
  return hidden;
}
"""


LAZY_SCROLL_JS = """
async (maxPx) => {
  const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
  const limit = Math.min(document.documentElement.scrollHeight, maxPx);
  for (let y = 0; y < limit; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 300));
  return document.documentElement.scrollHeight;
}
"""


def emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def kill_descendants() -> None:
    """Kill the Playwright driver and browser. Chromium runs in its own process
    group, so every descendant's group is killed, not only our children."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True).stdout
    children: dict[int, list[int]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    me = os.getpid()
    own_group = os.getpgid(me)
    stack, found = [me], []
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    for pid in found:
        try:
            group = os.getpgid(pid)
            if group != own_group:
                os.killpg(group, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            continue


def start_watchdog(seconds: float, url: str) -> None:
    """Heavy pages can wedge the renderer; evaluate() has no timeout of its own."""
    def fire() -> None:
        print(json.dumps({"ok": False, "error": f"time limit of {int(seconds)}s exceeded (page hangs)", "url": url}, ensure_ascii=False), flush=True)
        kill_descendants()
        os._exit(3)
    timer = threading.Timer(seconds, fire)
    timer.daemon = True
    timer.start()


CONSENT_FRAME_HINTS = (
    "consent", "cmp", "privacy", "cookie", "sourcepoint", "sp_message", "usercentrics",
    "onetrust", "didomi", "trustarc", "quantcast", "fundingchoices", "gdpr",
)


def consent_frames(page: Page) -> list:
    """Main frame plus frames that look like consent managers. Querying every
    frame waits on dead ad iframes (blocked requests) and stalls the capture."""
    frames = [page.main_frame]
    for frame in page.frames:
        if frame is page.main_frame or frame.is_detached():
            continue
        if any(hint in (frame.url or "").lower() for hint in CONSENT_FRAME_HINTS):
            frames.append(frame)
    return frames


def dismiss_consent(page: Page, budget: float = 15.0) -> bool:
    deadline = time.time() + budget
    clicked = False
    for frame in consent_frames(page):
        for sel in CONSENT_SELECTORS:
            if time.time() > deadline:
                break
            try:
                loc = frame.locator(sel).first
                if loc.is_visible(timeout=200):
                    loc.click(timeout=1500)
                    clicked = True
                    break
            except PlaywrightError:
                continue
        if clicked:
            break
        for text in CONSENT_TEXTS:
            if time.time() > deadline:
                break
            try:
                loc = frame.get_by_role("button", name=text, exact=True).first
                if loc.is_visible(timeout=150):
                    loc.click(timeout=1500)
                    clicked = True
                    break
            except PlaywrightError:
                continue
        if clicked or time.time() > deadline:
            break
    if clicked:
        # Some consent managers reload the page after the choice.
        page.wait_for_timeout(800)
        try:
            page.wait_for_load_state("domcontentloaded", timeout=10000)
            page.wait_for_load_state("networkidle", timeout=5000)
        except PlaywrightError:
            pass
    for _ in range(3):
        try:
            page.add_style_tag(content=CONSENT_CSS)
            break
        except PlaywrightError:
            page.wait_for_timeout(1000)
    return clicked


def close_overlays(page: Page) -> int:
    """Close newsletter, paywall teaser and app banners that sit above the content."""
    closed = 0
    for sel in CLOSE_SELECTORS:
        if closed >= 3:
            break
        try:
            loc = page.locator(sel)
            for i in range(min(loc.count(), 3)):
                item = loc.nth(i)
                if item.is_visible(timeout=150):
                    item.click(timeout=1000)
                    closed += 1
                    page.wait_for_timeout(300)
        except PlaywrightError:
            continue
    return closed


def open_page(pw, args, scale: float):
    # WebGL runs on SwiftShader in headless mode and can burn several cores for minutes.
    browser = pw.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled", "--disable-webgl", "--disable-3d-apis"])
    context = browser.new_context(
        viewport={"width": args.width, "height": args.height},
        device_scale_factor=scale,
        locale="de-DE",
        timezone_id="Europe/Berlin",
        user_agent=USER_AGENT,
        color_scheme="dark" if args.dark else "light",
        reduced_motion="reduce",
    )
    context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    if not args.allow_ads:
        # A URL pattern keeps every other request inside the driver; a catch-all
        # Python handler round-trips each request and stalls heavy pages.
        context.route(AD_PATTERN, lambda route: route.abort())
    page = context.new_page()
    page.goto(args.url, wait_until="domcontentloaded", timeout=args.timeout * 1000)
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except PlaywrightError:
        pass
    page.wait_for_timeout(int(args.wait * 1000))
    dismissed = False
    if not args.no_dismiss:
        dismissed = dismiss_consent(page)
        close_overlays(page)
        if not args.keep_overlays:
            page.wait_for_timeout(600)
            page.evaluate(HIDE_OVERLAYS_JS)
    if args.hide:
        page.add_style_tag(content=", ".join(args.hide) + " { display: none !important; }")
    return browser, page, dismissed


def cmd_shot(args) -> None:
    out = Path(args.output).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser, page, dismissed = open_page(pw, args, args.scale)
        try:
            title = page.title()
            if args.selector:
                el = page.locator(args.selector).first
                el.scroll_into_view_if_needed(timeout=5000)
                page.wait_for_timeout(400)
                el.screenshot(path=str(out), timeout=30000)
            elif args.full:
                height = page.evaluate(LAZY_SCROLL_JS, args.max_height)
                page.wait_for_timeout(400)
                if not (args.no_dismiss or args.keep_overlays):
                    page.evaluate(HIDE_OVERLAYS_JS)
                if height > args.max_height:
                    page.screenshot(path=str(out), full_page=True, clip={"x": 0, "y": 0, "width": args.width, "height": args.max_height}, timeout=60000)
                else:
                    page.screenshot(path=str(out), full_page=True, timeout=60000)
            else:
                page.screenshot(path=str(out), timeout=30000)
        finally:
            browser.close()
    emit({"ok": True, "kind": "shot", "file": str(out), "url": args.url, "title": title, "consentDismissed": dismissed, "bytes": out.stat().st_size})


SCROLL_TO_JS = "(y) => { window.scrollTo(0, y); return window.scrollY; }"


def ease(p: float) -> float:
    return 2 * p * p if p < 0.5 else 1 - ((-2 * p + 2) ** 2) / 2


def cmd_scroll(args) -> None:
    if not shutil.which("ffmpeg"):
        emit({"ok": False, "error": "ffmpeg not found"}, 1)
    out = Path(args.output).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with tempfile.TemporaryDirectory(prefix="dsho-scroll-") as tmp, sync_playwright() as pw:
        browser, page, dismissed = open_page(pw, args, 1)
        try:
            title = page.title()
            doc_height = page.evaluate(LAZY_SCROLL_JS, 60000)
            page.wait_for_timeout(500)
            clean = not (args.no_dismiss or args.keep_overlays)
            if clean:
                page.evaluate(HIDE_OVERLAYS_JS)
            max_scroll = max(0, doc_height - args.height)
            start = min(args.start, max_scroll)
            distance = args.distance if args.distance is not None else min(max_scroll - start, int(args.speed * args.duration))
            distance = max(0, min(distance, max_scroll - start))
            page.evaluate(SCROLL_TO_JS, start)
            page.wait_for_timeout(300)

            hold = int(args.hold * args.fps)
            moving = max(1, int(args.duration * args.fps))
            frame = 0

            def snap() -> Path:
                nonlocal frame
                path = Path(tmp) / f"{frame:05d}.jpg"
                page.screenshot(path=str(path), type="jpeg", quality=args.quality, timeout=30000)
                frame += 1
                return path

            first = snap()
            for _ in range(hold - 1):
                shutil.copy(first, Path(tmp) / f"{frame:05d}.jpg")
                frame += 1
            for i in range(1, moving + 1):
                page.evaluate(SCROLL_TO_JS, start + distance * ease(i / moving))
                if clean and i % 45 == 0:
                    page.evaluate(HIDE_OVERLAYS_JS)
                snap()
            last = Path(tmp) / f"{frame - 1:05d}.jpg"
            for _ in range(hold):
                shutil.copy(last, Path(tmp) / f"{frame:05d}.jpg")
                frame += 1
        finally:
            browser.close()

        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-framerate", str(args.fps), "-i", str(Path(tmp) / "%05d.jpg"),
            "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf),
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            emit({"ok": False, "error": f"ffmpeg: {res.stderr.strip()[-400:]}"}, 1)
    emit({
        "ok": True,
        "kind": "scroll",
        "file": str(out),
        "url": args.url,
        "title": title,
        "width": args.width,
        "height": args.height,
        "fps": args.fps,
        "frames": frame,
        "durationSec": round(frame / args.fps, 2),
        "scrolledPx": distance,
        "pageHeight": doc_height,
        "consentDismissed": dismissed,
        "bytes": out.stat().st_size,
        "renderSec": round(time.time() - started, 1),
    })


def main() -> None:
    parser = argparse.ArgumentParser(prog="dsho capture", description="Screenshots and scroll videos with Playwright")
    sub = parser.add_subparsers(dest="cmd", required=True)

    def common(p, width: int, height: int) -> None:
        p.add_argument("url")
        p.add_argument("-o", "--output", required=True, help="output file")
        p.add_argument("--width", type=int, default=width)
        p.add_argument("--height", type=int, default=height)
        p.add_argument("--wait", type=float, default=2.0, help="seconds to wait after load")
        p.add_argument("--timeout", type=int, default=45, help="navigation timeout in seconds")
        p.add_argument("--no-dismiss", action="store_true", help="do not dismiss cookie banners")
        p.add_argument("--dark", action="store_true", help="prefers-color-scheme: dark")
        p.add_argument("--max-time", type=float, help="hard overall limit in seconds")
        p.add_argument("--allow-ads", action="store_true", help="do not block ad networks")
        p.add_argument("--keep-overlays", action="store_true", help="do not hide fixed overlays")
        p.add_argument("--hide", action="append", default=[], help="hide a CSS selector (repeatable)")

    shot = sub.add_parser("shot", help="Screenshot")
    common(shot, 1440, 900)
    shot.add_argument("--full", action="store_true", help="full page")
    shot.add_argument("--selector", help="only this element (CSS selector)")
    shot.add_argument("--scale", type=float, default=1.0, help="device scale factor, 2 for retina")
    shot.add_argument("--max-height", type=int, default=16000, help="height limit for --full in pixels")
    shot.set_defaults(func=cmd_shot)

    scroll = sub.add_parser("scroll", help="scroll video (MP4)")
    common(scroll, 1920, 1080)
    scroll.add_argument("--duration", type=float, default=12.0, help="seconds of scrolling")
    scroll.add_argument("--fps", type=int, default=30)
    scroll.add_argument("--speed", type=float, default=450.0, help="maximum pixels per second")
    scroll.add_argument("--start", type=int, default=0, help="start offset in pixels")
    scroll.add_argument("--distance", type=int, help="fixed scroll distance in pixels")
    scroll.add_argument("--hold", type=float, default=1.0, help="hold at start and end in seconds")
    scroll.add_argument("--quality", type=int, default=92, help="JPEG quality of the frames")
    scroll.add_argument("--crf", type=int, default=18, help="x264 CRF, lower is better")
    scroll.set_defaults(func=cmd_scroll)

    args = parser.parse_args()
    limit = args.max_time or (90 if args.cmd == "shot" else 180 + 12 * args.duration)
    start_watchdog(limit, args.url)
    try:
        args.func(args)
    except PlaywrightError as err:
        emit({"ok": False, "error": str(err).splitlines()[0][:400], "url": getattr(args, "url", None)}, 1)


if __name__ == "__main__":
    main()
