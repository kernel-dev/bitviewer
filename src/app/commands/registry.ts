// Every user-facing action in one place. Menus, keyboard shortcuts, the
// command palette and the help dialog are all built from this registry.
import type { IconNode } from "lucide";
import type { MenuItem } from "../../ui/kit";

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

const isTextTarget = (target: EventTarget | null) =>
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLInputElement &&
    !["checkbox", "radio", "range", "button"].includes(target.type));

/** Does the shortcut spec ("Ctrl+Shift+S", "F1", "Esc", "Ctrl++") match the event? */
export function matchKey(spec: string, event: KeyboardEvent): boolean {
  const parts = spec.split("+");
  let key = parts.pop() ?? "";
  if (key === "" && spec.endsWith("+")) {
    key = "+";
    parts.pop();
  }
  const modifiers = new Set(parts.map((path) => path.toLowerCase()));
  const ctrlOrCommand = event.ctrlKey || event.metaKey;
  if (
    modifiers.has("ctrl") !== ctrlOrCommand ||
    modifiers.has("alt") !== event.altKey
  )
    return false;
  const lowerKey = key.toLowerCase();
  // "+" is typed with Shift on most layouts, so don't insist on Shift there
  if (lowerKey !== "+" && modifiers.has("shift") !== event.shiftKey)
    return false;
  if (/^[0-9]$/.test(lowerKey))
    return (
      event.code === `Digit${lowerKey}` || event.code === `Numpad${lowerKey}`
    );
  if (/^[a-z]$/.test(lowerKey))
    return event.code === `Key${lowerKey.toUpperCase()}`;
  const aliases: Record<string, string> = {
    esc: "escape",
    del: "delete",
    space: " ",
  };
  return event.key.toLowerCase() === (aliases[lowerKey] ?? lowerKey);
}

export class CommandRegistry {
  private cmds = new Map<string, Command>();

  add(...commands: Command[]) {
    for (const command of commands) this.cmds.set(command.id, command);
  }

  get(id: string): Command {
    const command = this.cmds.get(id);
    if (!command) throw new Error(`Unknown command ${id}`);
    return command;
  }

  all(): Command[] {
    return [...this.cmds.values()];
  }

  label(command: Command): string {
    return typeof command.label === "function"
      ? command.label()
      : command.label;
  }

  icon(command: Command): IconNode | undefined {
    return typeof command.icon === "function" ? command.icon() : command.icon;
  }

  isEnabled(command: Command): boolean {
    return !command.enabled || command.enabled();
  }

  run(id: string) {
    const command = this.get(id);
    if (this.isEnabled(command)) command.run();
  }

  /** Menu entries from command ids; "sep" adds a separator. */
  menu(ids: (string | MenuItem)[]): MenuItem[] {
    return ids.map((id): MenuItem => {
      if (id === "sep") return "sep";
      if (typeof id !== "string") return id; // a ready-made entry (e.g. a submenu)
      const command = this.get(id);
      return {
        label: this.label(command),
        icon: this.icon(command),
        shortcut: command.keys?.[0],
        disabled: !this.isEnabled(command),
        action: command.run,
      };
    });
  }

  /** Runs the command bound to this key press. Returns true when handled. */
  handleKey(event: KeyboardEvent): boolean {
    const inText = isTextTarget(event.target);
    for (const command of this.cmds.values()) {
      for (const spec of command.keys ?? []) {
        if (!matchKey(spec, event)) continue;
        // plain keys (Delete, Space…) belong to the text field while typing
        const plain = !/(^|\+)(Ctrl|Alt)\+/.test(spec) && !/^F\d+$/.test(spec);
        if (inText && plain) return false;
        event.preventDefault();
        if (this.isEnabled(command)) command.run();
        return true;
      }
    }
    return false;
  }
}
