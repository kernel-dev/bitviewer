// Read-only and reserved fields: any change to their bits asks first.
// "Allow for this field" lasts for the session; "Change it" allows one change,
// or, while typing in a text box, every change until that box loses focus.

import { maxValue } from "../core/format/integers";
import type { Group, ValueModel } from "../core/model";
import { ask } from "../ui/kit";
import { play } from "../ui/sound";

export class ProtectedFields {
  /** Fields the user agreed to change for the rest of this session. */
  private unlocked = new WeakSet<Group>();
  /** Fields allowed only until the text box being typed in loses focus. */
  private allowedWhileTyping = new Set<Group>();

  constructor(private model: ValueModel) {}

  /** True when the user allowed changes to this field for the session. */
  isUnlocked(group: Group): boolean {
    return this.unlocked.has(group);
  }

  /** Asks whether the `blocked` fields may change. Resolves true when the
   *  user allows it. `typing` is the text box the change comes from, so
   *  "Change it" holds until it loses focus. */
  async confirm(blocked: Group[], typing?: HTMLElement): Promise<boolean> {
    const answer = await this.ask(blocked);
    if (answer === "cancel") return false;
    if (answer === "always")
      for (const group of blocked) this.unlocked.add(group);
    else if (typing) {
      for (const group of blocked) this.allowedWhileTyping.add(group);
      typing.addEventListener("blur", () => this.allowedWhileTyping.clear(), {
        once: true,
      });
    }
    return true;
  }

  /** Read-only / reserved fields whose bits differ in `next` and that haven't been allowed. */
  blockedBy(next: bigint): Group[] {
    const model = this.model;
    const diff = (model.value ^ next) & model.mask;
    if (!diff) return [];
    return model.groups.filter(
      (group) =>
        group.protected &&
        !this.unlocked.has(group) &&
        !this.allowedWhileTyping.has(group) &&
        (diff >> BigInt(group.lo)) & maxValue(group.width),
    );
  }

  private async ask(groups: Group[]): Promise<"cancel" | "always" | "once"> {
    play("error");
    const kind = (group: Group) =>
      group.access === "ro" ? "read-only" : "reserved";
    const one = groups.length === 1;
    const answer = await ask(
      one ? `Change a ${kind(groups[0])} field?` : "Change protected fields?",
      one
        ? `This changes “${groups[0].name}” ${groups[0].label()}, which is marked ${kind(groups[0])}.` +
            (groups[0].description ? `\n\n${groups[0].description}` : "")
        : `This changes fields marked read-only or reserved: ${groups.map((group) => `“${group.name}” ${group.label()} (${kind(group)})`).join(", ")}.`,
      [
        { id: "cancel", label: "Cancel" },
        {
          id: "always",
          label: one ? "Allow for this field" : "Allow for these fields",
          className: "outline",
        },
        { id: "once", label: "Change it", className: "primary" },
      ],
    );
    return answer === "always" || answer === "once" ? answer : "cancel";
  }
}
