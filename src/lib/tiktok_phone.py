"""
Posts a video to TikTok through the Android phone plugged into this PC.

TikTok's API will not post for an unaudited app, so this does what a person
does: the file goes onto the phone, opens in the TikTok app, and the app is
tapped through to Post. uiautomator2 finds buttons by their text, not by screen
position, so a different phone size does not move the taps.

    python src/lib/tiktok_phone.py doctor            # is the phone ready?
    python src/lib/tiktok_phone.py inspect           # screenshot + UI dump, for fixing selectors
    python src/lib/tiktok_phone.py post --file v.mp4 --caption-file c.txt [--account @handle] [--dry-run [--hold]] [--delay 10]
    python src/lib/tiktok_phone.py account [--account @handle]   # which account is active / switch and verify
    python src/lib/tiktok_phone.py comments [--account @handle] [--posts 2]   # read comments on the newest posts
    python src/lib/tiktok_phone.py reply --replies-file r.json [--account @handle] [--dry-run]   # answer them

Always prints ONE JSON line last: {"ok": true} or {"ok": false, "stage", "error",
"screenshot"}. The worker reads that line; everything else goes to stderr.

Needs:  pip install uiautomator2
Phone:  USB debugging on, no PIN/pattern lock (the screen is woken and swiped
        open, it cannot type a PIN), TikTok logged in to the account to post as.
"""

import argparse
import html
import json
import os
import random
import re
import subprocess
import sys
import time

DEFAULT_ADB = os.path.join(
    os.path.expanduser("~"), "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"
)
PHONE_DIR = "/sdcard/DCIM/AutoPost"

# Everything TikTok (or Android) may put in the way between opening the video
# and the Post button. Tapped whenever seen; none of them cancel the post.
DISMISS = [
    "Not now", "Not Now", "Skip", "Got it", "OK", "Ok", "Allow", "While using the app",
    "Only this time", "Close", "Maybe later", "Later", "Continue", "Dismiss", "No thanks",
]
# TikTok's own nags that only ever ask for more (contacts sync, notifications,
# rating) - turned down, in any capitalisation.
DECLINE = r"(?i)^\s*(don.t allow|deny|not now|no thanks|skip|maybe later|later|dismiss|close)\s*$"
# Android's runtime-permission dialog, on stock and Google builds alike.
PERMISSION_PKG = r"com\.(google\.)?android\.(permissioncontroller|packageinstaller)"
# A permission a post can actually need. Everything else (contacts, location,
# phone, notifications) is denied with "Don't ask again", so it never returns.
PERMISSION_NEEDED = r"(?i)photo|media|video|file|storage|camera|microphone|record audio"
# A dialog or banner with no words to tap, only an X: matched on the icon's
# label (content-desc) or on the character itself.
CLOSE_ICON = r"(?i)^\s*(close|close button|dismiss|x|×|✕|✖|╳)\s*$"
NEXT = r"(?i)^\s*next\s*$"
POST = r"(?i)^\s*post( now)?\s*$"
# The description box on the post screen, by its hint text on recent builds.
DESCRIPTION_HINT = r"(?i).*(describe|description|add a caption|write a caption).*"
UPLOAD_ERROR = r"(?i).*(couldn.t (upload|post)|upload failed|failed to post|try again).*"
# The prompt a stopped post leaves behind on the next launch.
PROMPT_CONTINUE = r"(?i)^\s*continue editing this post\??\s*$"
PROMPT_EDIT = r"(?i)^\s*edit\s*$"
PROMPT_DISCARD = r"(?i)^\s*(discard|discard post|discard edits|start over)\s*$"
# The comment button on a video carries the count: "Read or add comments. 12 comments".
COMMENTS_BUTTON = r"(?i).*read or add comments.*"
REPLYING_TO = r"(?i)^\s*replying to .*"
# Labels TikTok hangs under a comment - not what the person wrote.
COMMENT_BADGE = r"(?i)^(first comment|creator|author|pinned|liked by (the )?creator|friend|following|follows you|top fan)$"
COMMENT_ERROR = r"(?i).*(couldn.t (post|send)|comment failed|too fast|try again later|comments are turned off).*"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


class Stage(Exception):
    def __init__(self, stage, message):
        super().__init__(message)
        self.stage = stage


def pause(lo=0.6, hi=1.6):
    """A person does not tap at machine speed."""
    time.sleep(random.uniform(lo, hi))


class Phone:
    def __init__(self, adb, serial, package):
        self.adb = adb
        self.serial = serial
        self.package = package
        self.d = None

    # --- adb ---------------------------------------------------------------
    def adb_run(self, *args, check=True, timeout=120):
        cmd = [self.adb] + (["-s", self.serial] if self.serial else []) + list(args)
        # The phone answers in UTF-8; Windows' default codepage chokes on it.
        r = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout
        )
        if check and r.returncode != 0:
            raise Stage("adb", f"{' '.join(args[:3])} failed: {(r.stderr or r.stdout).strip()}")
        return r.stdout.strip()

    def shell(self, cmd, check=True):
        return self.adb_run("shell", cmd, check=check)

    def connect(self):
        if not os.path.exists(self.adb):
            raise Stage("adb", f"adb not found at {self.adb} - set ADB_PATH")
        subprocess.run([self.adb, "start-server"], capture_output=True, timeout=60)
        devices = [
            line.split()[0]
            for line in self.adb_run("devices").splitlines()[1:]
            if line.strip().endswith("device")
        ]
        if not devices:
            raise Stage("connect", "no phone attached (or USB debugging not allowed on it)")
        if self.serial and self.serial not in devices:
            raise Stage("connect", f"phone {self.serial} not attached; attached: {devices}")
        if not self.serial:
            if len(devices) > 1:
                raise Stage("connect", f"several phones attached, set PHONE_SERIAL: {devices}")
            self.serial = devices[0]

        # uiautomator2 talks through the same adb server started above.
        os.environ.setdefault("ADBUTILS_ADB_PATH", self.adb)
        try:
            import uiautomator2 as u2
        except ImportError:
            raise Stage("setup", "uiautomator2 is not installed - pip install uiautomator2")
        # A run that crashed leaves its UiAutomator server on the phone, still
        # holding the one accessibility slot, and the next start then fails
        # with AccessibilityServiceAlreadyRegisteredError. Clear it first, and
        # once more if the start still collides.
        for attempt in range(2):
            self.clear_stale_server()
            try:
                self.d = u2.connect(self.serial)
                # The server only starts on the first call; make it start here.
                self.d.info
                break
            except Exception as e:
                if attempt == 1 or "AlreadyRegistered" not in f"{type(e).__name__}: {e}":
                    raise
                log("  UiAutomator slot still held - clearing it and retrying")
                time.sleep(2)
        self.d.implicitly_wait(0)
        return self

    def clear_stale_server(self):
        """Kills any UiAutomator server a previous run left behind."""
        self.shell("pkill -f uia2.Main; pkill -f uiautomator", check=False)
        self.shell("am force-stop com.github.uiautomator", check=False)
        time.sleep(1)

    def release(self):
        """Stops this run's UiAutomator server so the next run can start one."""
        if self.d is not None:
            try:
                self.d.stop_uiautomator()
            except Exception:
                pass
        if self.serial:
            self.clear_stale_server()

    # --- screen ------------------------------------------------------------
    def wake(self):
        d = self.d
        d.screen_on()
        pause(0.5, 1.0)
        # Swipe the lock screen away. A PIN or pattern would stop here.
        #
        # uiautomator2's unlock() did not clear this phone's swipe-only lock,
        # and the driver then reported a PIN the phone does not have. A plain
        # swipe up from low on the screen does it, so that is tried first,
        # a few times, before giving up.
        for _ in range(3):
            if not self._locked():
                break
            w, h = d.window_size()
            self.shell(f"input swipe {w // 2} {int(h * 0.85)} {w // 2} {int(h * 0.25)} 250", check=False)
            pause(1.0, 1.5)
        if self._locked():
            d.unlock()
            pause(1.0, 1.5)
        if self._locked():
            raise Stage("unlock", "the phone is locked with a PIN/pattern - remove it for posting")
        # Stays on while plugged in, so a long upload is not cut off by sleep.
        self.shell("svc power stayon usb", check=False)

    def _locked(self):
        out = self.shell("dumpsys window", check=False)
        return bool(re.search(r"mShowingLockscreen=true|isStatusBarKeyguard=true|mKeyguardShowing=true", out))

    def screenshot(self, shots, tag, why):
        try:
            os.makedirs(shots, exist_ok=True)
            p = os.path.join(shots, f"{tag}-{why}-{int(time.time())}.png")
            self.d.screenshot(p)
            return p
        except Exception as e:  # a screenshot must never hide the real error
            log("screenshot failed:", e)
            return None

    def answer_permission(self):
        """Answers Android's permission dialog by what it asks for.

        Matched by resource id, not button text: the text is "Allow", "ALLOW"
        or translated depending on the build. An uppercase "ALLOW / DENY"
        contacts dialog once matched nothing in DISMISS and blocked the post.
        """
        d = self.d
        msg = d(resourceIdMatches=PERMISSION_PKG + r":id/permission_message")
        if not msg.exists:
            return False
        asks = msg.get_text() or ""
        if re.search(PERMISSION_NEEDED, asks):
            ids = ["permission_allow_foreground_only_button", "permission_allow_button", "permission_allow_one_time_button"]
            verdict = "allowing"
        else:
            box = d(resourceIdMatches=PERMISSION_PKG + r":id/do_not_ask_checkbox")
            if box.exists and not box.info.get("checked"):
                box.click()
                pause(0.3, 0.6)
            ids = ["permission_deny_and_dont_ask_again_button", "permission_deny_button"]
            verdict = "denying"
        for rid in ids:
            btn = d(resourceIdMatches=PERMISSION_PKG + r":id/" + rid)
            if btn.exists:
                log(f"  {verdict} permission: {asks.strip()[:80]}")
                btn.click()
                pause(0.5, 1.0)
                return True
        return False

    def close_icon(self, unlabelled=False):
        """Taps the X on a dialog TikTok put over the screen, if there is one.

        The X in the top-left corner is left alone: that one belongs to the
        editor and the post screen, and closes the post rather than a popup.

        `unlabelled` also takes a small, wordless button in the top-right of
        whatever is showing - the "Add phone" sheet's X carries no label at
        all. Only for a caller that is already stuck: on the editor that
        corner holds tools.
        """
        d = self.d
        w, h = d.window_size()
        for finder in (d(descriptionMatches=CLOSE_ICON), d(textMatches=CLOSE_ICON)):
            for i in range(min(finder.count, 4)):
                try:
                    b = finder[i].info.get("bounds") or {}
                except Exception:
                    continue  # gone between the count and the read
                x, y = (b.get("left", 0) + b.get("right", 0)) // 2, (b.get("top", 0) + b.get("bottom", 0)) // 2
                if not x and not y:
                    continue
                if x < w * 0.2 and y < h * 0.15:
                    continue
                log(f"  closing a dialog by its X at {x},{y}")
                d.click(x, y)
                pause(0.6, 1.0)
                return True
        if not unlabelled:
            return False
        spots = []
        for m in re.finditer(r"<node [^>]*>", d.dump_hierarchy()):
            node = m.group(0)
            b = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', node)
            if not b or 'clickable="true"' not in node:
                continue
            if not re.search(r' text=""', node) or not re.search(r' content-desc=""', node):
                continue
            l, t, r, bt = map(int, b.groups())
            x, y = (l + r) // 2, (t + bt) // 2
            small = w * 0.03 <= r - l <= w * 0.16 and w * 0.03 <= bt - t <= w * 0.16
            if small and x > w * 0.78 and h * 0.06 < y < h * 0.5:
                spots.append((y, x))
        if not spots:
            return False
        y, x = min(spots)
        log(f"  closing a dialog by its unlabelled X at {x},{y}")
        d.click(x, y)
        pause(0.8, 1.2)
        return True

    def dismiss_popups(self, icons=True):
        # The system dialog first: DISMISS has "Allow", and a contacts prompt
        # must be denied, not tapped through.
        hit = self.answer_permission()
        decline = self.d(textMatches=DECLINE)
        if decline.exists:
            log(f"  declining '{decline.get_text()}'")
            decline.click()
            pause(0.4, 0.8)
            hit = True
        for text in DISMISS:
            el = self.d(text=text)
            # Greyed out, it is a form's submit ("Add phone" -> Continue), and
            # tapping it does nothing, forever.
            if el.exists and el.info.get("enabled", True):
                log(f"  dismissing '{text}'")
                el.click()
                pause(0.4, 0.8)
                hit = True
        # Only when nothing with words on it was there to tap.
        if icons and not hit:
            hit = self.close_icon()
        return hit

    def wait_for(self, finder, timeout, stage, what, icons=True):
        """Waits for an element, clearing popups while it does."""
        end = time.time() + timeout
        while time.time() < end:
            el = finder()
            if el.exists:
                return el
            self.dismiss_popups(icons=icons)
            time.sleep(0.8)
        raise Stage(stage, f"{what} did not appear within {timeout}s")

    # --- the file ----------------------------------------------------------
    def push(self, local, tag):
        remote = f"{PHONE_DIR}/{tag}.mp4"
        self.shell(f"mkdir -p {PHONE_DIR}")
        log(f"  pushing {os.path.basename(local)} -> {remote}")
        self.adb_run("push", local, remote, timeout=600)
        self.shell(f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{remote}", check=False)
        # The share needs a content:// uri, which exists once the scan lands.
        # MediaStore records the real path (/storage/emulated/0/...), not the
        # /sdcard alias it was pushed to, so match on the folder and name.
        suffix = remote[len("/sdcard"):]
        end = time.time() + 30
        while time.time() < end:
            out = self.shell(
                "content query --uri content://media/external/video/media "
                f"--projection _id --where \"_data LIKE '%{suffix}'\"",
                check=False,
            )
            m = re.search(r"_id=(\d+)", out)
            if m:
                return remote, f"content://media/external/video/media/{m.group(1)}"
            time.sleep(1)
        raise Stage("push", f"the phone never indexed {remote}, so it cannot be shared to TikTok")

    def remove(self, remote):
        self.shell(f"rm -f '{remote}'", check=False)
        self.shell(f"am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://{remote}", check=False)

    # --- TikTok ------------------------------------------------------------
    def open_in_tiktok(self, uri):
        if self.package not in self.shell("pm list packages", check=False):
            raise Stage("open", f"{self.package} is not installed on the phone")
        # From a clean start, so every post walks the same screens.
        self.d.app_stop(self.package)
        pause(1.0, 2.0)
        self.shell(
            "am start -a android.intent.action.SEND -t video/mp4 "
            f"--eu android.intent.extra.STREAM {uri} --grant-read-uri-permission -p {self.package}"
        )
        pause(2.0, 3.0)
        # TikTok takes shares in more than one activity; Android may ask which.
        for label in ["TikTok", "Post", "Upload"]:
            el = self.d(text=label, packageName="android")
            if el.exists:
                el.click()
                pause()
                break

    def to_post_screen(self):
        """Taps Next through the editor screens until the description box shows."""
        d = self.d
        end = time.time() + 120
        while time.time() < end:
            if self._description().exists and d(textMatches=POST).exists:
                return
            nxt = d(textMatches=NEXT)
            if nxt.exists:
                log("  next")
                nxt.click()
                pause(1.5, 2.5)
                continue
            self.dismiss_popups()
            time.sleep(1)
        raise Stage("editor", "never reached the post screen (no Next button, no description box)")

    def _description(self):
        d = self.d
        hinted = d(className="android.widget.EditText", textMatches=DESCRIPTION_HINT)
        return hinted if hinted.exists else d(className="android.widget.EditText")

    def write_caption(self, caption):
        box = self._description()
        if not box.exists:
            raise Stage("caption", "no description box on the post screen")
        box.click()
        pause()
        box.set_text(caption)
        pause()
        self.hide_keyboard()
        typed = (self._description().get_text() or "").strip()
        if caption and caption.split()[0] not in typed:
            raise Stage("caption", f"the caption did not take (box reads: {typed[:60]!r})")

    def keyboard_shown(self):
        out = self.shell("dumpsys input_method", check=False)
        return "mInputShown=true" in out

    def hide_keyboard(self):
        """
        The keyboard sits over Post, and a tap lands on whatever is on top.
        Back closes only the keyboard while it is up - with it down, Back would
        leave the post screen - so it is pressed only while the keyboard shows.
        """
        for _ in range(3):
            if not self.keyboard_shown():
                return
            self.d.press("back")
            pause(0.8, 1.2)
        if self.keyboard_shown():
            raise Stage("caption", "the keyboard would not close and covers the Post button")

    # --- accounts ----------------------------------------------------------
    def clear_draft_prompt(self):
        """
        "Continue editing this post?" - left by a dry run, which stops TikTok
        on the post screen. While it shows, the UI dump holds only the prompt,
        so the account check reads nothing and the post is (correctly)
        refused. Back does not close it; "Save draft" would leave a stray
        draft. Edit, then Back out of the editor, clears it.
        """
        d = self.d
        if not d(textMatches=PROMPT_CONTINUE).exists:
            return False
        log("  clearing a leftover 'Continue editing this post?' prompt")
        d(textMatches=PROMPT_EDIT).click()
        pause(2.0, 3.0)
        for _ in range(4):
            disc = d(textMatches=PROMPT_DISCARD)
            if disc.exists:
                disc.click()
                pause(1.5, 2.0)
                break
            if d(text="Profile").exists and d(text="Home").exists:
                break
            d.press("back")
            pause(1.5, 2.0)
        return True

    def open_profile(self):
        """TikTok from a clean start, on the Profile tab."""
        d = self.d
        d.app_start(self.package, stop=True)
        pause(4.0, 6.0)
        self.clear_draft_prompt()
        try:
            tab = self.wait_for(lambda: d(text="Profile"), 30, "account", "the Profile tab")
        except Stage:
            # Something nobody listed is covering the feed. Back closes most
            # sheets and dialogs; if it backed out of TikTok, open it again.
            if self.close_icon(unlabelled=True):
                pause(1.0, 1.5)
                self.clear_draft_prompt()
            else:
                log("  Profile tab hidden - pressing back once")
                d.press("back")
                pause(1.5, 2.5)
            if d.app_current().get("package") != self.package:
                d.app_start(self.package)
                pause(4.0, 6.0)
            tab = self.wait_for(lambda: d(text="Profile"), 30, "account", "the Profile tab (after pressing back)")
        tab.click()
        pause(2.5, 3.5)
        self.dismiss_popups()

    def current_handle(self):
        """The @handle the Profile tab shows - the account a post would go to."""
        self.open_profile()
        end = time.time() + 20
        while time.time() < end:
            m = re.findall(r'text="@([\w.]+)"', self.d.dump_hierarchy())
            if m:
                return m[0].lower()
            if self.clear_draft_prompt():
                self.d(text="Profile").click()
                pause(2.0, 3.0)
            if not self.dismiss_popups():
                self.close_icon(unlabelled=True)
            time.sleep(1)
        raise Stage("account", "could not read the active @handle on the Profile tab")

    def switch_account(self, handle):
        """
        Makes `handle` the active TikTok account, and PROVES it.

        TikTok posts to whichever account is active, silently. Posting one
        account's video to the other is the one mistake this driver must never
        make, so the switch is verified by reading the Profile tab afterwards
        and anything but an exact match stops the post.
        """
        want = handle.lstrip("@").lower()
        now = self.current_handle()
        if now == want:
            log(f"  account @{now} already active")
            return now
        log(f"  switching @{now} -> @{want}")
        d = self.d
        self._open_switcher()
        # The sheet lists each logged-in account as a row labelled in
        # content-desc - with the bare handle for some accounts, and with the
        # DISPLAY NAME for others (@sciencelabaratory appears as "Husein
        # Muminovic371"). The text node inside is not the tappable one.
        target = None
        end = time.time() + 15
        while time.time() < end and target is None:
            for el in (d(description=want, clickable=True), d(description=f"@{want}", clickable=True)):
                if el.exists:
                    target = el
                    break
            if target is None:
                time.sleep(1)
        if target is not None:
            target.click()
            self._wait_switched()
        else:
            # Not listed by handle: try the other rows one at a time and READ
            # where each lands. Switching is harmless; posting is what must be
            # right, and it is still gated on the exact handle below.
            rows = self._switcher_rows(exclude={now, "add account", "close"})
            log(f"  @{want} not listed by handle; trying {len(rows)} other account row(s)")
            got = now
            for i, label in enumerate(rows):
                if i:
                    self._open_switcher()
                row = d(description=label, clickable=True)
                if not row.exists:
                    continue
                row.click()
                self._wait_switched()
                got = self.current_handle()
                log(f"    row \"{label}\" is @{got}")
                if got == want:
                    break
            if got != want:
                raise Stage("account", f"@{want} is not in the account switcher - add it on the phone first")
        got = self.current_handle()
        if got != want:
            raise Stage("account", f"switched but the active account is @{got}, not @{want}")
        log(f"  now on @{got}")
        return got

    def _wait_switched(self):
        """
        Waits for a tapped account row to finish switching.

        The switch is not instant: the sheet closes, Settings stays on screen
        for several seconds, and only around ten seconds in does TikTok reload
        onto the feed as the other account. It has to be left ALONE for that:
        the old fixed 5-7 second pause ended in current_handle() force-stopping
        TikTok mid-switch, and polling the screen while waiting did the same
        damage - both left the old account active, so the right row was tapped,
        read back as the old account, and the post was refused with "not in
        the account switcher". Only a hands-off wait switched every time.
        """
        time.sleep(20)
        d = self.d
        end = time.time() + 30
        while time.time() < end:
            # The feed's Profile tab is the sign it is done; Settings has none.
            if d(text="Profile").exists:
                break
            time.sleep(3)
        pause(2.0, 3.0)

    def _switcher_rows(self, exclude):
        """content-desc of each account row in the open switcher sheet."""
        import re as _re
        xml = self.d.dump_hierarchy()
        rows = []
        for node in _re.finditer(r'<node[^>]*clickable="true"[^>]*>', xml):
            m = _re.search(r'content-desc="([^"]*)"', node.group(0))
            label = (m.group(1) if m else "").strip()
            if label and label.lower() not in exclude and label not in rows:
                rows.append(label)
        return rows

    def _open_switcher(self):
        """Profile -> Profile menu -> Settings and privacy -> Switch account."""
        d = self.d
        self.open_profile()
        # Profile menu -> Settings and privacy -> Switch account. The route
        # through Settings, not a tap near the top of Profile: "nearest the
        # top" there is the Thoughts bubble, and the name title jumped to the
        # Inbox. Menu entries carry their label in content-desc, not text.
        self.wait_for(lambda: d(description="Profile menu"), 15, "account", "the Profile menu").click()
        pause(1.5, 2.5)
        self.wait_for(
            lambda: d(textMatches=r"(?i)^\s*settings and privacy\s*$")
            if d(textMatches=r"(?i)^\s*settings and privacy\s*$").exists
            else d(descriptionMatches=r"(?i)^\s*settings and privacy\s*$"),
            15, "account", "Settings and privacy",
        ).click()
        pause(2.0, 3.0)
        # It sits at the very bottom, under Login, and the list has grown: ten
        # scrolls reached it on the tenth, after the last look, so the entry
        # was on screen when the driver gave up. Look once more after the
        # final scroll, and allow more of them.
        switch = None
        for attempt in range(16):
            el = d(description="Switch account")
            if not el.exists:
                el = d(textMatches=r"(?i)^\s*switch account\s*$")
            if el.exists:
                switch = el
                break
            if attempt == 15:
                break
            d.swipe_ext("up", scale=0.6)
            pause(0.8, 1.2)
        if switch is None:
            raise Stage("account", "no Switch account entry in Settings and privacy")
        switch.click()
        pause(1.5, 2.5)

    def post(self):
        d = self.d
        self.hide_keyboard()
        btn = d(textMatches=POST)
        if not btn.exists:
            raise Stage("post", "no Post button on the post screen")
        if not self._description().exists:
            raise Stage("post", "left the post screen before Post could be tapped")
        btn.click()
        log("  post tapped")
        pause(2.0, 3.0)
        # Some builds confirm once more.
        confirm = d(textMatches=r"(?i)^\s*post now\s*$")
        if confirm.exists:
            confirm.click()
            pause(2.0, 3.0)

        # The post screen closing means TikTok took it. The upload runs on in
        # the background; wait for it so the phone is not re-used under it.
        end = time.time() + 600
        # A tap on Post can be swallowed: the screen stays exactly as it was,
        # Post button and all, and the old loop then waited out its ten minutes
        # on a post that was never sent (an 8-second video, twice). The same
        # tap made again went straight through. So while the post screen is
        # still showing with nothing uploading, Post is tapped again - which
        # cannot double-post, because the screen only stays when it did not go.
        retap_at = time.time() + 20
        retaps = 0
        while time.time() < end:
            if d(textMatches=UPLOAD_ERROR).exists:
                raise Stage("upload", "TikTok reported the upload failed")
            uploading = d(textMatches=r".*\d{1,3}\s?%.*").exists
            if not self._description().exists and not uploading:
                return
            if not uploading and retaps < 5 and time.time() >= retap_at:
                again = d(textMatches=POST)
                if again.exists and self._description().exists:
                    retaps += 1
                    log(f"  still on the post screen - tapping Post again ({retaps})")
                    self.hide_keyboard()
                    again.click()
                    pause(2.0, 3.0)
                retap_at = time.time() + 20
            time.sleep(3)
        raise Stage("upload", "the upload did not finish within 10 minutes")


    # --- comments ----------------------------------------------------------
    #
    # TikTok's own ids are obfuscated and change between builds (f67, eo1...),
    # so a comment is found by SHAPE: every comment ends in a row holding its
    # age and a "Reply" button, and what sits above that row, at the same left
    # edge, is the commenter's name and then what they wrote.

    def _nodes(self):
        """Every on-screen node that carries text or can be tapped."""
        out = []
        for m in re.finditer(r"<node[^>]*>", self.d.dump_hierarchy()):
            raw = m.group(0)

            def attr(key, raw=raw):
                got = re.search(r'\b' + key + r'="([^"]*)"', raw)
                return html.unescape(got.group(1)) if got else ""

            b = re.match(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", attr("bounds"))
            if not b:
                continue
            l, t, r, btm = (int(x) for x in b.groups())
            out.append({
                "text": attr("text"), "desc": attr("content-desc"), "id": attr("resource-id").split("/")[-1],
                "cls": attr("class").split(".")[-1], "click": attr("clickable") == "true",
                "l": l, "t": t, "r": r, "b": btm,
            })
        return out

    def _grid(self):
        """The profile's video tiles, newest first: (tap point, pinned)."""
        nodes = self._nodes()
        counts = sorted((n for n in nodes if n["id"] == "tv_play_count"), key=lambda n: (n["t"], n["l"]))
        pins = [n for n in nodes if n["text"].strip().lower() == "pinned"]
        tiles = []
        for c in counts:
            pinned = any(abs(p["l"] - c["l"]) < 40 and 0 < c["t"] - p["t"] < 520 for p in pins)
            tiles.append(((c["l"] + c["r"]) // 2, c["t"] - 200, pinned))
        return tiles

    def _on_profile_grid(self):
        return any(n["id"] == "tv_play_count" for n in self._nodes())

    def back_to_grid(self):
        """Backs out of a comment sheet / video to the profile's grid."""
        for _ in range(5):
            if self._on_profile_grid():
                return
            if self.keyboard_shown():
                self.d.press("back")
                pause(0.8, 1.2)
                continue
            self.d.press("back")
            pause(1.5, 2.5)
        # Lost: start over from the Profile tab rather than tap blind.
        self.open_profile()

    def open_post(self, index):
        """Opens the index-th newest video that is not pinned; returns what it shows."""
        end = time.time() + 20
        tiles = []
        while time.time() < end:
            tiles = [t for t in self._grid() if not t[2]]
            if tiles:
                break
            self.dismiss_popups()
            time.sleep(1)
        if index >= len(tiles):
            raise Stage("comments", f"the profile shows {len(tiles)} unpinned video(s), wanted #{index + 1}")
        x, y, _ = tiles[index]
        self.d.click(x, y)
        pause(3.5, 5.0)
        btn = self.wait_for(
            lambda: self.d(descriptionMatches=COMMENTS_BUTTON), 20, "comments", "the video's comment button"
        )
        count = re.search(r"([\d.,]+[KM]?)\s*comment", btn.info.get("contentDescription") or "", re.I)
        nodes = self._nodes()
        caption = next((n["text"] for n in nodes if n["id"] == "desc" and n["text"]), "")
        creator = next((n["text"] for n in nodes if n["id"] == "title" and n["text"]), "")
        age = next((n["text"] for n in nodes if n["id"] == "tv_post_time"), "")
        return {
            "caption": caption.strip(),
            "creator": creator.strip(),
            "age": re.sub(r"^[^\w]+", "", age).strip(),
            "commentCount": count.group(1) if count else "0",
        }

    def open_comments(self):
        self.d(descriptionMatches=COMMENTS_BUTTON).click()
        # The sheet animates in; read too early and it holds only its header.
        end = time.time() + 15
        while time.time() < end:
            if self.d(className="android.widget.EditText").exists:
                pause(1.0, 1.8)
                return
            time.sleep(0.8)
        raise Stage("comments", "the comment sheet did not open")

    def _visible_comments(self):
        """Comments on screen now, each with where its Reply button is."""
        nodes = self._nodes()
        header = next((n for n in nodes if re.match(r"(?i)^comments?\s*[\d.,KM]*$", n["text"].strip())), None)
        top = header["b"] if header else 0
        keys_top = min((n["t"] for n in nodes if n["cls"] == "EditText"), default=10 ** 6)
        replies = sorted(
            (n for n in nodes if n["text"].strip() == "Reply" and n["click"] and top < n["t"] < keys_top),
            key=lambda n: n["t"],
        )
        if not replies:
            return []
        # A reply to a comment is indented; a comment itself sits furthest left.
        ages = {}
        for r in replies:
            row = [n for n in nodes if n["cls"] == "TextView" and abs(n["t"] - r["t"]) < 30 and n["r"] <= r["l"] + 4]
            if row:
                ages[id(r)] = max(row, key=lambda n: n["l"])
        if not ages:
            return []
        edge = min(a["l"] for a in ages.values())
        out, floor = [], top
        for r in replies:
            age = ages.get(id(r))
            if age is None:
                continue
            block = [
                n for n in nodes
                if floor <= n["t"] < r["t"] - 10 and abs(n["l"] - age["l"]) <= 6 and n["text"].strip()
            ]
            block.sort(key=lambda n: n["t"])
            floor = r["b"]
            author = next((n for n in block if n["cls"] == "Button"), None)
            if author is None:
                continue
            body = [
                n for n in block
                if n["t"] > author["t"] and n["cls"] == "TextView" and not re.match(COMMENT_BADGE, n["text"].strip())
            ]
            if not body:
                continue
            said = next((n for n in body if n["click"]), body[0])
            # The like count sits by the heart, on the Reply row; none shown is none.
            liked = next(
                (n for n in nodes if abs(n["t"] - r["t"]) < 40 and n["l"] > r["r"]
                 and (n["id"] == "tv_like_count" or re.match(r"^[\d.,]+[KM]?$", n["text"].strip()))),
                None,
            )
            out.append({
                "author": author["text"].strip(), "text": said["text"].strip(), "age": age["text"].strip(),
                "likes": count_of(liked["text"]) if liked else 0,
                "nested": age["l"] > edge + 20, "replyAt": ((r["l"] + r["r"]) // 2, (r["t"] + r["b"]) // 2),
                "bottom": r["b"],
            })
        # "View 2 replies" under a comment: somebody already answered it.
        more = [n for n in nodes if re.match(r"(?i)^(view|hide)\b.*\brepl(y|ies)\b", n["text"].strip())]
        for i, c in enumerate(out):
            if c["nested"]:
                continue
            until = next((o["bottom"] for o in out[i + 1:] if not o["nested"]), 10 ** 6)
            c["hasReplies"] = (
                any(c["bottom"] <= n["t"] < until for n in more)
                or any(o["nested"] and c["bottom"] <= o["bottom"] <= until for o in out)
            )
        return out

    def _scroll_comments(self):
        w, h = self.d.window_size()
        self.d.swipe(w // 2, int(h * 0.74), w // 2, int(h * 0.50), 0.35)
        pause(1.2, 2.0)

    def read_comments(self, limit):
        """Top-level comments in the open sheet, in the order TikTok shows them."""
        seen, out = set(), []
        for _ in range(6):
            fresh = 0
            for c in self._visible_comments():
                key = (c["author"], c["text"])
                if c["nested"] or key in seen:
                    continue
                seen.add(key)
                fresh += 1
                out.append({k: c.get(k) for k in ("author", "text", "age", "likes", "hasReplies")})
            if len(out) >= limit or fresh == 0:
                break
            self._scroll_comments()
        return out[:limit]

    def find_comment(self, author, text):
        """Scrolls the open sheet until this comment is on screen."""
        want = (author.strip(), " ".join(text.split()))
        for _ in range(8):
            for c in self._visible_comments():
                if not c["nested"] and (c["author"], " ".join(c["text"].split())) == want:
                    return c
            self._scroll_comments()
        return None

    def reply_to(self, comment, reply, dry_run):
        """Types `reply` under one comment and sends it."""
        d = self.d
        d.click(*comment["replyAt"])
        pause(1.5, 2.5)
        box = self.wait_for(
            lambda: d(className="android.widget.EditText", textMatches=REPLYING_TO), 10, "reply", "the reply box",
            # The comment sheet has an X of its own; closing it loses the comment.
            icons=False,
        )
        # Sent to the wrong person is worse than not sent.
        # The screen dump writes an emoji as "..", the box gives it whole.
        hint = "".join(".." if ord(ch) > 0xFFFF else ch for ch in (box.get_text() or ""))
        if comment["author"][:12] not in hint:
            raise Stage("reply", f"the reply box is addressed to someone else ({hint[:60]!r})")
        pause(1.0, 2.5)
        box.set_text(reply)
        pause(1.5, 3.0)
        box = d(className="android.widget.EditText")
        typed = (box.get_text() or "").strip()
        if typed != reply.strip():
            raise Stage("reply", f"the reply did not take (box reads: {typed[:60]!r})")
        if dry_run:
            box.clear_text()
            pause(0.5, 1.0)
            return
        edit = box.info["bounds"]
        send = [
            n for n in self._nodes()
            if n["click"] and n["cls"] == "Button" and edit["bottom"] - 10 <= n["t"] < edit["bottom"] + 220
        ]
        if not send:
            raise Stage("reply", "no send button under the reply box")
        btn = max(send, key=lambda n: n["r"])
        d.click((btn["l"] + btn["r"]) // 2, (btn["t"] + btn["b"]) // 2)
        # Sent when the box lets go of the text.
        end = time.time() + 20
        while time.time() < end:
            now = d(className="android.widget.EditText")
            if not now.exists or (now.get_text() or "").strip() != reply.strip():
                pause(1.5, 2.5)
                return
            if d(textMatches=COMMENT_ERROR).exists:
                raise Stage("reply", "TikTok refused the reply")
            time.sleep(1)
        raise Stage("reply", "the reply was typed but never left the box")


def cmd_doctor(p, args):
    p.connect()
    info = p.d.info
    installed = p.package in p.shell("pm list packages", check=False)
    battery = p.shell("dumpsys battery", check=False)
    level = re.search(r"level: (\d+)", battery)
    return {
        "ok": installed,
        "serial": p.serial,
        "screenOn": info.get("screenOn"),
        "locked": p._locked(),
        "tiktokInstalled": installed,
        "battery": int(level.group(1)) if level else None,
        **({} if installed else {"stage": "doctor", "error": f"{p.package} not installed"}),
    }


def cmd_account(p, args):
    """Reports the active account, or switches to --account and verifies it."""
    p.connect()
    p.wake()
    handle = p.switch_account(args.account) if args.account else p.current_handle()
    return {"ok": True, "account": handle}


def cmd_inspect(p, args):
    p.connect()
    os.makedirs(args.shots, exist_ok=True)
    stamp = int(time.time())
    png = os.path.join(args.shots, f"inspect-{stamp}.png")
    xml = os.path.join(args.shots, f"inspect-{stamp}.xml")
    p.d.screenshot(png)
    with open(xml, "w", encoding="utf-8") as f:
        f.write(p.d.dump_hierarchy())
    return {"ok": True, "screenshot": png, "hierarchy": xml}


def cmd_post(p, args):
    with open(args.caption_file, encoding="utf-8") as f:
        caption = f.read().strip()
    if not os.path.exists(args.file):
        raise Stage("input", f"no video at {args.file}")

    p.connect()
    if args.delay:
        # Time to start a screen recording before anything moves.
        for left in range(args.delay, 0, -1):
            log(f"  starting in {left}s")
            time.sleep(1)
    p.wake()
    if args.account:
        # Before the file goes anywhere: a wrong account is refused outright.
        p.switch_account(args.account)
    remote, uri = p.push(args.file, args.tag)
    hold = args.dry_run and args.hold
    try:
        p.open_in_tiktok(uri)
        p.to_post_screen()
        p.write_caption(caption)
        if args.dry_run:
            shot = p.screenshot(args.shots, args.tag, "dry-run")
            if not hold:
                p.d.app_stop(p.package)
            return {"ok": True, "dryRun": True, "held": hold, "screenshot": shot}
        p.post()
        return {"ok": True}
    except Stage:
        raise
    except Exception as e:  # uiautomator2 errors carry no stage of their own
        raise Stage("ui", f"{type(e).__name__}: {e}")
    finally:
        # A retry pushes the file again, so nothing piles up on the phone.
        # Held on the post screen, TikTok is still reading the file.
        if not hold:
            p.remove(remote)


def count_of(text):
    """ "40" -> 40, "1.2K" -> 1200. """
    m = re.match(r"^\s*([\d.,]+)\s*([KM]?)\s*$", text or "", re.I)
    if not m:
        return 0
    try:
        return int(float(m.group(1).replace(",", "")) * {"": 1, "K": 1000, "M": 1000000}[m.group(2).upper()])
    except ValueError:
        return 0


def same_post(shown, wanted):
    """Whether a video's caption on screen is the one a reply was written for."""
    norm = lambda s: re.sub(r"\W+", "", s.lower())[:40]
    return bool(norm(wanted)) and norm(shown).startswith(norm(wanted)[:24])


def cmd_comments(p, args):
    """Reads the comments on the account's newest posts. Changes nothing."""
    p.connect()
    p.wake()
    handle = p.switch_account(args.account) if args.account else p.current_handle()
    posts = []
    try:
        for i in range(args.posts):
            try:
                post = p.open_post(i)
            except Stage as e:
                if i == 0:
                    raise
                log(f"  no post #{i + 1}: {e}")
                break
            post["index"] = i
            post["comments"] = []
            if post["commentCount"] not in ("0", ""):
                p.open_comments()
                post["comments"] = p.read_comments(args.max_comments)
            log(f"  post #{i + 1}: {post['commentCount']} comment(s), read {len(post['comments'])}")
            posts.append(post)
            p.back_to_grid()
            pause(1.5, 3.0)
    finally:
        p.d.app_stop(p.package)
    return {"ok": True, "account": handle, "posts": posts}


def cmd_reply(p, args):
    """Sends the replies in --replies-file: [{id, caption, author, comment, reply}]."""
    with open(args.replies_file, encoding="utf-8") as f:
        todo = json.load(f)
    p.connect()
    p.wake()
    handle = p.switch_account(args.account) if args.account else p.current_handle()
    results = []
    try:
        for n, item in enumerate(todo):
            res = {"id": item["id"], "ok": False}
            results.append(res)
            try:
                opened = False
                for i in range(args.posts):
                    post = p.open_post(i)
                    if same_post(post["caption"], item["caption"]):
                        opened = True
                        break
                    p.back_to_grid()
                    pause(1.0, 2.0)
                if not opened:
                    raise Stage("reply", "that video is no longer among the newest posts")
                p.open_comments()
                comment = p.find_comment(item["author"], item["comment"])
                if comment is None:
                    raise Stage("reply", "the comment is no longer there")
                if comment.get("hasReplies"):
                    raise Stage("reply", "the comment has been answered already")
                p.reply_to(comment, item["reply"], args.dry_run)
                res["ok"] = True
                if args.dry_run:
                    res["dryRun"] = True
                log(f"  {'typed (dry run)' if args.dry_run else 'replied'} to {item['author'][:30]}")
            except Stage as e:
                res["stage"], res["error"] = e.stage, str(e)
                res["screenshot"] = p.screenshot(args.shots, args.tag, e.stage)
                log(f"  reply {item['id']} failed: {e}")
            except Exception as e:  # uiautomator2 errors carry no stage of their own
                res["stage"], res["error"] = "ui", f"{type(e).__name__}: {e}"
                res["screenshot"] = p.screenshot(args.shots, args.tag, "ui")
            p.back_to_grid()
            if n < len(todo) - 1:
                # Nobody answers five comments in five seconds.
                pause(20.0, 55.0)
    finally:
        p.d.app_stop(p.package)
    return {"ok": True, "account": handle, "results": results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["doctor", "inspect", "post", "account", "comments", "reply"])
    ap.add_argument("--posts", type=int, default=2, help="how many of the newest unpinned videos to look at")
    ap.add_argument("--max-comments", type=int, default=12, help="comments read per video")
    ap.add_argument("--replies-file", help="reply: JSON list of {id, caption, author, comment, reply}")
    ap.add_argument("--adb", default=os.environ.get("ADB_PATH") or DEFAULT_ADB)
    ap.add_argument("--serial", default=os.environ.get("PHONE_SERIAL"))
    ap.add_argument("--package", default=os.environ.get("TIKTOK_PACKAGE") or "com.zhiliaoapp.musically")
    ap.add_argument("--shots", default=os.path.join("media", "phone"))
    ap.add_argument("--file")
    ap.add_argument("--account", help="@handle to post as; switched to and verified before posting")
    ap.add_argument("--caption-file")
    ap.add_argument("--tag", default=str(int(time.time())))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--hold", action="store_true",
        help="with --dry-run: leave TikTok open on the filled-in post screen instead of closing it",
    )
    ap.add_argument("--delay", type=int, default=0, help="seconds to wait before starting")
    args = ap.parse_args()

    p = Phone(args.adb, args.serial, args.package)
    try:
        result = {"doctor": cmd_doctor, "inspect": cmd_inspect, "post": cmd_post,
                  "account": cmd_account, "comments": cmd_comments, "reply": cmd_reply}[args.command](p, args)
    except Stage as e:
        shot = p.screenshot(args.shots, args.tag, e.stage) if p.d else None
        result = {"ok": False, "stage": e.stage, "error": str(e), "screenshot": shot}
    except Exception as e:
        shot = p.screenshot(args.shots, args.tag, "crash") if p.d else None
        result = {"ok": False, "stage": "crash", "error": f"{type(e).__name__}: {e}", "screenshot": shot}
    finally:
        try:
            p.release()
        except Exception:
            pass
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
