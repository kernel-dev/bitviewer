// What the user can do with peripherals: the block header's actions (collapse,
// edit, export, add a register, sort, move, ungroup, remove), a value's
// "Peripheral" submenu, and creating, joining or leaving a peripheral.
// The data lives in the Workspace; peripheral-ui.ts builds the UI.

import type { ValueCard } from "../../card/card";
import { ValueModel } from "../../core/model";
import {
  freeName,
  moveBlock,
  nextOffset,
  peripheralToJSON,
} from "../../core/workspace";
import { exportCode } from "../../dialogs/export";
import { appSettings } from "../../platform/settings";
import { ask, html, type MenuItem, toast } from "../../ui/kit";
import { play } from "../../ui/sound";
import type { App } from "../app";
import {
  askOffset,
  editPeripheralDialog,
  type PeripheralActions,
  peripheralHeader,
} from "./peripheral-ui";

const hex = (value: bigint) => `0x${value.toString(16).toUpperCase()}`;

/** A peripheral's block on screen. `shows` is what the header was drawn from. */
interface Section {
  element: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  shows: string;
}

export class PeripheralController {
  /** Blocks by peripheral name, kept between layouts so only what changed is redrawn. */
  private sections = new Map<string, Section>();

  constructor(private app: App) {}

  private get workspace() {
    return this.app.workspace;
  }

  /** The block for one peripheral with `registerCount` registers: a header,
   *  plus a body the cards go into. The same elements are returned each time;
   *  the header is redrawn when the peripheral or its register count changed. */
  section(
    name: string,
    registerCount: number,
  ): { element: HTMLElement; body: HTMLElement } {
    const peripheral = this.workspace.peripherals.get(name)!;
    const shows = JSON.stringify([peripheralToJSON(peripheral), registerCount]);
    let section = this.sections.get(name);
    if (!section) {
      const header = peripheralHeader(
        peripheral,
        registerCount,
        this.actions(name),
      );
      const body = html("div", {
        class: "periph-body",
        role: "group",
        "aria-label": `Registers of ${name}`,
      });
      const element = html(
        "section",
        { class: "periph", "data-peripheral": name },
        header,
        body,
      );
      section = { element, header, body, shows };
      this.sections.set(name, section);
    } else if (section.shows !== shows) {
      const header = peripheralHeader(
        peripheral,
        registerCount,
        this.actions(name),
      );
      section.header.replaceWith(header);
      section.header = header;
      section.shows = shows;
    }
    section.element.classList.toggle("collapsed", peripheral.collapsed);
    return section;
  }

  /** Forgets the blocks of peripherals that are gone. */
  keepSections(names: Set<string>) {
    for (const name of [...this.sections.keys()])
      if (!names.has(name)) this.sections.delete(name);
  }

  /** The "Peripheral" submenu of a value. */
  menu(card: ValueCard): MenuItem[] {
    const model = card.model;
    const items: MenuItem[] = [
      {
        label: "New peripheral from this value…",
        action: () => void this.create(card),
      },
    ];
    const others = this.workspace
      .usedPeripherals()
      .filter((peripheral) => peripheral.name !== model.block);
    if (others.length)
      items.push({
        label: model.block ? "Move to another peripheral" : "Add to peripheral",
        submenu: others.map((peripheral) => ({
          label: peripheral.name,
          shortcut: peripheral.base === null ? undefined : hex(peripheral.base),
          action: () => this.moveTo(card, peripheral.name),
        })),
      });
    if (model.block)
      items.push(
        "sep",
        {
          label: "Change offset…",
          action: () => void this.editOffset(card),
        },
        {
          label: `Take out of ${model.block}`,
          action: () => {
            model.setPeripheral("", null);
            this.workspace.relayout();
          },
        },
      );
    return items;
  }

  async editOffset(card: ValueCard) {
    const model = card.model;
    if (!model.block) return;
    const offset = await askOffset(model.name, model.block, model.offset);
    if (offset === undefined) return;
    model.setPeripheral(model.block, offset);
  }

  /** Records a change to the peripherals themselves (not their values). */
  private changed() {
    this.workspace.relayout();
    this.app.history.touch();
  }

  private actions(name: string): PeripheralActions {
    const workspace = this.workspace;
    const history = this.app.history;
    const peripheral = () => workspace.peripherals.get(name)!;
    return {
      toggle: () => {
        peripheral().collapsed = !peripheral().collapsed;
        play("toggle");
        this.changed();
      },
      edit: () => void this.edit(name),
      exportCode: () =>
        void exportCode({
          kind: "peripheral",
          peripheral: peripheral(),
          models: workspace.members(name).map((card) => card.model),
        }),
      addRegister: () => {
        const members = workspace.members(name);
        const taken = new Set(workspace.cards.map((card) => card.model.name));
        let number = members.length + 1;
        while (taken.has(`${name}.REG${number}`)) number++;
        const model = new ValueModel({
          width: 32,
          name: `${name}.REG${number}`,
          view: appSettings.get("default_view"),
          defaultRowBase: appSettings.get("default_base"),
        });
        model.setPeripheral(
          name,
          nextOffset(members.map((card) => card.model)),
        );
        if (peripheral().collapsed) peripheral().collapsed = false;
        const last = workspace.cards.indexOf(members[members.length - 1]);
        workspace.addValue(32, model, last + 1);
      },
      sortByOffset: () => {
        const sorted = [...workspace.members(name)].sort((first, second) => {
          const [a, b] = [first.model.offset, second.model.offset];
          if (a === null || b === null)
            return a === null ? (b === null ? 0 : 1) : -1;
          return a < b ? -1 : a > b ? 1 : 0;
        });
        let next = 0;
        workspace.reorder(
          workspace.cards.map((card) =>
            card.model.block === name ? sorted[next++] : card,
          ),
        );
      },
      move: (direction) => {
        workspace.reorder(
          moveBlock(workspace.cards, name, direction, workspace.blockOf),
        );
      },
      ungroup: () => {
        const members = workspace.members(name);
        history.hold(); // one undo step
        try {
          for (const card of members) card.model.setPeripheral("", null);
        } finally {
          history.release();
        }
        workspace.relayout();
        toast(`Ungrouped ${name}; Ctrl+Z puts it back`);
      },
      remove: async () => {
        const members = workspace.members(name);
        const answer = await ask(
          "Remove peripheral",
          `Remove ${name} and its ${members.length} register${members.length === 1 ? "" : "s"}?`,
          [
            { id: "cancel", label: "Cancel" },
            { id: "yes", label: "Remove", className: "danger-btn" },
          ],
        );
        if (answer !== "yes") return;
        for (const card of members) workspace.drop(card);
        workspace.relayout();
        history.touch();
        play("remove");
      },
    };
  }

  /** Renames a peripheral or changes its base address or description. */
  private async edit(name: string) {
    const workspace = this.workspace;
    const history = this.app.history;
    const peripheral = workspace.peripherals.get(name);
    if (!peripheral) return;
    const result = await editPeripheralDialog(
      `Peripheral “${name}”`,
      peripheral,
      (candidate) => candidate !== name && workspace.peripherals.has(candidate),
    );
    if (!result) return;
    history.hold(); // renaming touches every register: one undo step
    try {
      workspace.peripherals.delete(name);
      workspace.peripherals.set(result.name, {
        ...peripheral,
        name: result.name,
        base: result.base,
        description: result.description,
      });
      for (const card of workspace.members(name)) {
        const model = card.model;
        // "UART0.CTRL" follows a rename of UART0
        if (result.name !== name && model.name.startsWith(`${name}.`))
          model.setName(result.name + model.name.slice(name.length));
        model.setPeripheral(result.name, model.offset);
        card.rebuildWhenShown(); // the address badge depends on the base
      }
      workspace.relayout();
      history.touch();
    } finally {
      history.release();
    }
  }

  /** Makes a new peripheral with this value as its first register. */
  private async create(card: ValueCard) {
    const workspace = this.workspace;
    const model = card.model;
    const dot = model.name.indexOf(".");
    const suggestion = freeName(
      dot > 0 ? model.name.slice(0, dot) : "PERIPH",
      (name) => workspace.peripherals.has(name),
    );
    const result = await editPeripheralDialog(
      "New peripheral",
      {
        name: suggestion,
        base: null,
        description: "",
        offset: model.offset ?? 0n,
      },
      (name) => workspace.peripherals.has(name),
    );
    if (!result) return;
    workspace.peripherals.set(result.name, {
      name: result.name,
      base: result.base,
      description: result.description,
      collapsed: false,
    });
    model.setPeripheral(result.name, result.offset ?? null);
    workspace.relayout();
    play("group");
  }

  /** Adds a value to another peripheral, after its last register. */
  private moveTo(card: ValueCard, name: string) {
    const workspace = this.workspace;
    const members = workspace.members(name);
    const offset = nextOffset(members.map((member) => member.model));
    workspace.cards.splice(workspace.cards.indexOf(card), 1);
    workspace.cards.splice(
      workspace.cards.indexOf(members[members.length - 1]) + 1,
      0,
      card,
    );
    card.model.setPeripheral(name, offset);
    workspace.relayout();
    toast(`Moved to ${name} at offset ${hex(offset)}`);
  }
}
