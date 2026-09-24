"""
Posts a video to TikTok through the Android phone plugged into this PC.

TikTok's API will not post for an unaudited app, so this does what a person
does: the file goes onto the phone, opens in the TikTok app, and the app is
tapped through to Post. uiautomator2 finds buttons by their text, not by screen
position, so a different phone size does not move the taps.

    python src/lib/tiktok_phone.py doctor            # is the phone ready?
    python src/lib/tiktok_phone.py inspect           # screenshot + UI dump, for fixing selectors
    python src/lib/tiktok_phone.py post --file v.mp4 --caption-file c.txt [--dry-run]

Always prints ONE JSON line last: {"ok": true} or {"ok": false, "stage", "error",
"screenshot"}. The worker reads that line; everything else goes to stderr.

Needs:  pip install uiautomator2
Phone:  USB debugging on, no PIN/pattern lock (the screen is woken and swiped
        open, it cannot type a PIN), TikTok logged in to the account to post as.
"""

import argparse
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
NEXT = r"(?i)^\s*next\s*$"
POST = r"(?i)^\s*post( now)?\s*$"
# The description box on the post screen, by its hint text on recent builds.
DESCRIPTION_HINT = r"(?i).*(describe|description|add a caption|write a caption).*"
UPLOAD_ERROR = r"(?i).*(couldn.t (upload|post)|upload failed|failed to post|try again).*"


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
        self.d = u2.connect(self.serial)
        self.d.implicitly_wait(0)
        return self

    # --- screen ------------------------------------------------------------
    def wake(self):
        d = self.d
        d.screen_on()
        pause(0.5, 1.0)
        # Swipe the lock screen away. A PIN or pattern would stop here.
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

    def dismiss_popups(self):
        hit = False
        for text in DISMISS:
            el = self.d(text=text)
            if el.exists:
                log(f"  dismissing '{text}'")
                el.click()
                pause(0.4, 0.8)
                hit = True
        return hit

    def wait_for(self, finder, timeout, stage, what):
        """Waits for an element, clearing popups while it does."""
        end = time.time() + timeout
        while time.time() < end:
            el = finder()
            if el.exists:
                return el
            self.dismiss_popups()
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
        while time.time() < end:
            if d(textMatches=UPLOAD_ERROR).exists:
                raise Stage("upload", "TikTok reported the upload failed")
            if not self._description().exists and not d(textMatches=r".*\d{1,3}\s?%.*").exists:
                return
            time.sleep(3)
        raise Stage("upload", "the upload did not finish within 10 minutes")


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
    p.wake()
    remote, uri = p.push(args.file, args.tag)
    try:
        p.open_in_tiktok(uri)
        p.to_post_screen()
        p.write_caption(caption)
        if args.dry_run:
            shot = p.screenshot(args.shots, args.tag, "dry-run")
            p.d.app_stop(p.package)
            return {"ok": True, "dryRun": True, "screenshot": shot}
        p.post()
        return {"ok": True}
    except Stage:
        raise
    except Exception as e:  # uiautomator2 errors carry no stage of their own
        raise Stage("ui", f"{type(e).__name__}: {e}")
    finally:
        # A retry pushes the file again, so nothing piles up on the phone.
        p.remove(remote)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["doctor", "inspect", "post"])
    ap.add_argument("--adb", default=os.environ.get("ADB_PATH") or DEFAULT_ADB)
    ap.add_argument("--serial", default=os.environ.get("PHONE_SERIAL"))
    ap.add_argument("--package", default=os.environ.get("TIKTOK_PACKAGE") or "com.zhiliaoapp.musically")
    ap.add_argument("--shots", default=os.path.join("media", "phone"))
    ap.add_argument("--file")
    ap.add_argument("--caption-file")
    ap.add_argument("--tag", default=str(int(time.time())))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    p = Phone(args.adb, args.serial, args.package)
    try:
        result = {"doctor": cmd_doctor, "inspect": cmd_inspect, "post": cmd_post}[args.command](p, args)
    except Stage as e:
        shot = p.screenshot(args.shots, args.tag, e.stage) if p.d else None
        result = {"ok": False, "stage": e.stage, "error": str(e), "screenshot": shot}
    except Exception as e:
        shot = p.screenshot(args.shots, args.tag, "crash") if p.d else None
        result = {"ok": False, "stage": "crash", "error": f"{type(e).__name__}: {e}", "screenshot": shot}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
