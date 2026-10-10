import { spawn } from "node:child_process";

import { env } from "@/lib/env";
import { telegramText } from "@/lib/telegram";
import { logEvent, type EventLevel } from "./events";

/**
 * Tells the owner something they need to act on.
 *
 * The activity log is where everything goes; this is for the few moments that
 * need a person - an edit waiting in After Effects, After Effects needing to be
 * opened, an export picked up. Those also raise a Windows notification, because
 * the dashboard is not where anyone is looking while they are in After Effects.
 */
export function notify(args: {
  accountId?: string | null;
  level?: EventLevel;
  type: string;
  title: string;
  body: string;
  meta?: unknown;
}) {
  logEvent({
    accountId: args.accountId,
    level: args.level,
    type: args.type,
    message: `${args.title} - ${args.body}`,
    meta: args.meta,
    // Sent below, in its own words.
    telegram: false,
  });
  desktopToast(args.title, args.body);
  // A finished export goes to the phone as the video itself, with buttons
  // (sendForReview) - not as a second, text-only message.
  if (args.type !== "clip.exported") telegramText(`${args.title}\n${args.body}`);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Also keeps single quotes out of the PowerShell literal the XML sits in.
    .replace(/'/g, "&apos;");
}

/**
 * A Windows toast through the WinRT API PowerShell already ships with.
 *
 * Fire and forget: a notification that fails to show must never fail the
 * work it is reporting. The script goes over as -EncodedCommand so a hook with
 * quotes or an apostrophe cannot break out of it.
 */
function desktopToast(title: string, body: string) {
  if (process.platform !== "win32" || !env.desktopNotifications) return;

  const xml =
    '<toast><visual><binding template="ToastGeneric">' +
    `<text>${xmlEscape(title.slice(0, 80))}</text>` +
    `<text>${xmlEscape(body.slice(0, 280))}</text>` +
    "</binding></visual></toast>";

  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${xml}')`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    // PowerShell's own AppUserModelID: every Windows install has it registered,
    // so no shortcut or app registration is needed for the toast to show.
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
  ].join("\n");

  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // No notification is better than a failed job.
  }
}
