// hyper-view: one mod, many roles (props.role). layouts/hyper-view.json places it
// in several spots: window lights, sidebar, header, center view, terminal tabs,
// conversation panel, status bar and dialogs (background jobs: started once, by the status role).
import { View, div } from "gpui-kit";
import { props } from "herdr";
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
import { Tour } from "./tour.js";
import { startNotifier } from "./notifier.js";
import { Palette } from "./palette.js";
import { startAttention } from "./attention.js";
import { startMaintenance } from "./maintenance.js";

const ROLES = { pmenu: ProjectMenu, lights: Lights, header: Header, tabs: Tabs, "vmterm-empty": VmTermEmpty, "editor-bar": EditorBar, splash: Splash, tour: Tour, sidebar: Sidebar, view: Workspace, chat: Chat, status: Status, form: Form, palette: Palette };

// Overlay roles: they take the keyboard; their close() gives it back to the zone that had it (lib.js focus manager).
const OVERLAY_ROLES = new Set(["form", "palette", "pmenu", "tour"]);

export default class MacProjects extends View {
  init(p, cx) {
    const pr = p ?? props() ?? {};
    const role = pr.role ?? "view";
    if (OVERLAY_ROLES.has(role)) { this.overlayId = pr.overlay ?? `${role}:${Date.now()}`; this.role = role; overlayOpened(this.overlayId); }
    const Role = ROLES[role];
    this.part = Role ? new Role() : null;
    if (role === "sidebar") ensureInstalled();
    if (role === "status") { showSplash(); startDevBridge(cx); startSupervisor(cx); startNotifier(cx); startAttention(cx); startMaintenance(cx); }
    this.part?.init?.(cx);
  }

  // One final call when the overlay goes, whatever closed it (submit, Enter, Esc, Cancel, outside click,
  // overlay.close): the keyboard goes back to the main window's zone.
  async close(cx) {
    if (this.overlayId) { try { overlayClosed(this.overlayId, this.role); } catch {} }
  }

  render(cx) {
    if (this.overlayId) overlaySeen(this.overlayId);
    return this.part ? this.part.render(cx) : div().child("hyper-view: unknown role");
  }
}
