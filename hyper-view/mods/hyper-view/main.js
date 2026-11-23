// hyper-view: one mod, many roles (props.role). layouts/hyper-view.json places it
// in several spots: window lights, sidebar, header, center view, terminal tabs,
// conversation panel, status bar and dialogs (background jobs: started once, by the status role).
import { View, div } from "gpui-kit";
import { props, appHome, shared, setShared } from "herdr";
import * as fs from "fs/promises";
import { Lights, Header, Tabs, VmTermEmpty, ProjectMenu } from "./toolbar.js";
import { Sidebar } from "./sidebar.js";
import { Workspace } from "./workspace.js";
import { Chat } from "./chat.js";
import { Status } from "./status.js";
import { Form } from "./form.js";
import { ensureInstalled, overlayOpened, overlaySeen, overlayClosed } from "./lib.js";
import { startDevBridge } from "./devbridge.js";
import { EditorBar } from "./editor.js";
import { startSupervisor } from "./supervisor.js";
import { Splash, showSplash } from "./splash.js";
import { startNotifier } from "./notifier.js";
import { Palette } from "./palette.js";
import { startAttention } from "./attention.js";
import { startMaintenance } from "./maintenance.js";

const ROLES = { pmenu: ProjectMenu, lights: Lights, header: Header, tabs: Tabs, "vmterm-empty": VmTermEmpty, "editor-bar": EditorBar, splash: Splash, sidebar: Sidebar, view: Workspace, chat: Chat, status: Status, form: Form, palette: Palette };

// Overlay roles: they take the keyboard; their close() gives it back to the zone that had it (lib.js focus manager).
const OVERLAY_ROLES = new Set(["form", "palette", "pmenu"]);

const RP = (globalThis.__hvRenderProf2 ??= { since: new Date().toISOString(), k: {} });

export default class MacProjects extends View {
  init(p, cx) {
    const pr = p ?? props() ?? {};
    const role = pr.role ?? "view";
    if (OVERLAY_ROLES.has(role)) { this.overlayId = pr.overlay ?? `${role}:${Date.now()}`; this.role = role; overlayOpened(this.overlayId); }
    // Separate chat window (hp chat-window): no project view there, so the chat shows its conversation switcher.
    if (pr.standalone) { globalThis.__hvStandalone = true; if (shared("mp.view")?.kind !== "chatwin") setShared("mp.view", { kind: "chatwin" }); }
    const Role = ROLES[role];
    this.part = Role ? new Role() : null;
    if (role === "sidebar") ensureInstalled();
    if (role === "status") {
      // One writer per build (a hot reload supersedes the old timer instead of adding another).
      const mine = (globalThis.__hvRpTok = {});
      const rpTimer = cx.timer.every(30000, () => {
        if (globalThis.__hvRpTok !== mine) { try { rpTimer.cancel(); } catch {} return; }
        const out = Object.entries(RP.k).map(([k, r]) => ({ k, renders: r.n, avgMs: +(r.total / r.n).toFixed(1), maxMs: r.max, over50: r.slow })).sort((a, b) => b.renders * b.avgMs - a.renders * a.avgMs);
        const dir = `${String(appHome()).replace(/\\/g, "/")}/data/hyper-view`;
        fs.writeFile(`${dir}/render-stats.json`, JSON.stringify({ since: RP.since, at: new Date().toISOString(), out }, null, 1)).catch(() => {});
      });
 showSplash(); startDevBridge(cx); startSupervisor(cx); startNotifier(cx); startAttention(cx); startMaintenance(cx); }
    this.part?.init?.(cx);
  }

  // One final call when the overlay goes, whatever closed it (submit, Enter, Esc, Cancel, outside click,
  // overlay.close): the keyboard goes back to the main window's zone.
  async close(cx) {
    if (this.overlayId) { try { overlayClosed(this.overlayId, this.role); } catch {} }
  }

  render(cx) {
    if (this.overlayId) overlaySeen(this.overlayId);
    const t0 = Date.now();
    const el = this.part ? this.part.render(cx) : div().child("hyper-view: unknown role");
    // Render timing per part (and center view), written to data/hyper-view/render-stats.json every 30 s.
    const v = this.part instanceof Workspace ? shared("mp.view") : null;
    const key = v ? `view:${v.kind ?? "?"}${v.tab ? `/${v.tab}` : ""}` : (this.role ?? this.part?.constructor?.name ?? "?");
    const ms = Date.now() - t0, r = (RP.k[key] ??= { n: 0, total: 0, max: 0, slow: 0 });
    r.n++; r.total += ms; if (ms > r.max) r.max = ms; if (ms > 50) r.slow++;
    return el;
  }
}
