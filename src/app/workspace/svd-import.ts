// File › Import CMSIS-SVD…: read a device description, let the user pick
// registers, then add them as values (grouped into peripherals) or save them
// as templates.

import type { ValueCard } from "../../card/card";
import { ValueModel } from "../../core/model";
import {
  parseSvd,
  pickedRegisters,
  registerTemplate,
  type SvdDevice,
  type SvdRegister,
} from "../../core/svd";
import { freeName } from "../../core/workspace";
import { pickSvdRegisters } from "../../dialogs/svd";
import * as P from "../../platform/native";
import { appSettings } from "../../platform/settings";
import { ask, toast } from "../../ui/kit";
import { play } from "../../ui/sound";
import type { App } from "../app";
import { rememberDir, showError } from "../document";
import { bringIntoView } from "./reveal";

/** Above this many registers, the import asks first. */
const MANY = 50;

/** Reads a CMSIS-SVD file (picked, or `file` when dropped) and adds the
 *  registers the user chooses as values, or saves them as templates. */
export async function importSvd(app: App, file?: P.OpenedFile) {
  let opened = file ?? null;
  if (!opened) {
    try {
      opened = await P.pickAndRead(
        appSettings.get("last_dir") || (await P.defaultDir()),
        P.SVD_OPEN,
      );
    } catch (error) {
      showError("Could not open the SVD file", error);
      return;
    }
  }

  if (!opened) return;
  let device: SvdDevice;

  try {
    device = parseSvd(opened.text);
  } catch (error) {
    showError("Could not read the SVD file", error, opened.name);
    return;
  } finally {
    // the file's text can be hundreds of MB; nothing needs it after parsing,
    // so let it go now rather than while the picker is open
    opened.text = "";
  }

  if (opened.path) rememberDir(opened.path);
  const choice = await pickSvdRegisters(device, opened.name);
  if (!choice) return;
  const adding = choice.action === "add";

  // ask before the copies are made: a big array can be millions of registers
  if (choice.count > MANY) {
    const count = choice.count.toLocaleString("en-US");
    const answer = await ask(
      adding ? "Add many values?" : "Save many templates?",
      adding
        ? `This adds ${count} values to the workspace. Large workspaces get slower to scroll and edit${choice.count > 100_000 ? ", and this many may take a long time or run out of memory" : ""}.`
        : `This saves ${count} templates. Every template is kept in your settings and listed in the templates menu.`,
      [
        { id: "cancel", label: "Cancel" },
        {
          id: "yes",
          label: adding ? `Add ${count} values` : `Save ${count} templates`,
          className: "primary",
        },
      ],
    );
    if (answer !== "yes") return;
  }

  const registers = pickedRegisters(choice.picks);
  if (adding) addSvdValues(app, registers, device);
  else saveAsTemplates(registers, device);
}

/** Adds the registers to the user's templates, replacing ones with the same name. */
function saveAsTemplates(registers: SvdRegister[], device: SvdDevice) {
  const templates = registers.map((register) =>
    registerTemplate(register, device.name),
  );
  const names = new Set(
    templates.map((template) => template.name.toLowerCase()),
  );
  const kept = appSettings
    .get("templates")
    .filter((template) => !names.has(template.name.toLowerCase()));
  const replaced = appSettings.get("templates").length - kept.length;
  appSettings.set("templates", [...kept, ...templates]);
  toast(
    `Saved ${templates.length} template${templates.length === 1 ? "" : "s"}${replaced ? ` (${replaced} replaced)` : ""}`,
    "ok",
  );
}

/** Adds SVD registers as values, each in a peripheral block of its own
 *  peripheral (an existing one with the same name and base is reused). */
function addSvdValues(app: App, registers: SvdRegister[], device: SvdDevice) {
  const workspace = app.workspace;
  const deviceName = device.name;
  const blocks = new Map<string, string>(); // SVD peripheral → workspace peripheral
  app.history.hold(); // one undo step for the whole import
  let firstCard: ValueCard | null;

  try {
    // one layout for the whole import
    firstCard = workspace.batch(() => {
      let first: ValueCard | null = null;
      // registers of one peripheral come together (file order), so the
      // insert position is looked up once per peripheral, not per value
      let currentBlock = "";
      let nextIndex: number | undefined;

      for (const register of registers) {
        let block = blocks.get(register.peripheral);
        if (!block) {
          const existing = workspace.peripherals.get(register.peripheral);
          block =
            existing && existing.base === register.peripheralBase
              ? register.peripheral
              : freeName(register.peripheral, (name) =>
                  workspace.peripherals.has(name),
                );

          if (block !== register.peripheral || !existing)
            workspace.peripherals.set(block, {
              name: block,
              base: register.peripheralBase,
              description: register.peripheralDescription,
              collapsed: false,
            });

          blocks.set(register.peripheral, block);
        }

        if (block !== currentBlock) {
          currentBlock = block;
          const members = workspace.members(block);
          nextIndex = members.length
            ? workspace.cards.indexOf(members[members.length - 1]) + 1
            : undefined;
        }

        const model = new ValueModel({
          width: register.size,
          value: register.resetValue,
          name: register.path,
          view: appSettings.get("default_view"),
          defaultRowBase: appSettings.get("default_base"),
        });
        model.applyTemplate(registerTemplate(register, deviceName));
        model.setPeripheral(block, register.address - register.peripheralBase);
        model.setDescription(register.description);
        const card = workspace.addValue(model.width, model, nextIndex, false);
        if (nextIndex !== undefined) nextIndex++;
        first ??= card;
      }

      return first;
    });
  } finally {
    app.history.release();
  }

  play("add");

  if (firstCard)
    bringIntoView(firstCard.root, "start", () => workspace.buildNearView());

  toast(
    `Added ${registers.length} value${registers.length === 1 ? "" : "s"} from ${deviceName}`,
    "ok",
  );
}
