// Every user-facing action in one place. Menus, keyboard shortcuts, the
// command palette and the help dialog are all built from this registry.
import type { IconNode } from "lucide";
import type { MenuItem } from "./ui";

export type CommandGroup = "File" | "Edit" | "Value" | "View" | "Help";

export interface Command {
  id: string;
  group: CommandGroup;
  label: string | (() => string);
  icon?: IconNode | (() => IconNode);
  /** Shortcuts like "Ctrl+Shift+S". The first one is shown in menus. */
  keys?: string[];
  /** Extra words the command palette matches on. */
  keywords?: string;
  run: () => void;
  enabled?: () => boolean;
  /** Hide from the command palette (default: shown). */
  hidden?: boolean;
}

const isTextTarget = (t: EventTarget | null) =>
  t instanceof HTMLTextAreaElement ||
  (t instanceof HTMLInputElement && !["checkbox", "radio", "range", "button"].includes(t.type));

/** Does the shortcut spec ("Ctrl+Shift+S", "F1", "Esc", "Ctrl++") match the event? */
export function matchKey(spec: string, e: KeyboardEvent): boolean {
  const parts = spec.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && spec.endsWith("+")) {
    key = "+";
    parts.pop();
  }
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const ctrl = e.ctrlKey || e.metaKey;
  if (mods.has("ctrl") !== ctrl || mods.has("alt") !== e.altKey) return false;
  const k = key.toLowerCase();
  // "+" is typed with Shift on most layouts, so don't insist on Shift there
  if (k !== "+" && mods.has("shift") !== e.shiftKey) return false;
  if (/^[0-9]$/.test(k)) return e.code === `Digit${k}` || e.code === `Numpad${k}`;
  if (/^[a-z]$/.test(k)) return e.code === `Key${k.toUpperCase()}`;
  const aliases: Record<string, string> = { esc: "escape", del: "delete", space: " " };
  return e.key.toLowerCase() === (aliases[k] ?? k);
}

export class CommandRegistry {
  private cmds = new Map<string, Command>();

  add(...commands: Command[]) {
    for (const c of commands) this.cmds.set(c.id, c);
  }

  get(id: string): Command {
    const c = this.cmds.get(id);
    if (!c) throw new Error(`Unknown command ${id}`);
    return c;
  }

  all(): Command[] {
    return [...this.cmds.values()];
  }

  label(c: Command): string {
    return typeof c.label === "function" ? c.label() : c.label;
  }

  icon(c: Command): IconNode | undefined {
    return typeof c.icon === "function" ? c.icon() : c.icon;
  }

  isEnabled(c: Command): boolean {
    return !c.enabled || c.enabled();
  }

  run(id: string) {
    const c = this.get(id);
    if (this.isEnabled(c)) c.run();
  }

  /** Menu entries from command ids; "sep" adds a separator. */
  menu(ids: (string | "sep")[]): MenuItem[] {
    return ids.map((id): MenuItem => {
      if (id === "sep") return "sep";
      const c = this.get(id);
      return {
        label: this.label(c),
        icon: this.icon(c),
        shortcut: c.keys?.[0],
        disabled: !this.isEnabled(c),
        action: c.run,
      };
    });
  }

  /** Runs the command bound to this key press. Returns true when handled. */
  handleKey(e: KeyboardEvent): boolean {
    const inText = isTextTarget(e.target);
    for (const c of this.cmds.values()) {
      for (const spec of c.keys ?? []) {
        if (!matchKey(spec, e)) continue;
        // plain keys (Delete, Space…) belong to the text field while typing
        const plain = !/(^|\+)(Ctrl|Alt)\+/.test(spec) && !/^F\d+$/.test(spec);
        if (inText && plain) return false;
        e.preventDefault();
        if (this.isEnabled(c)) c.run();
        return true;
      }
    }
    return false;
  }
}
