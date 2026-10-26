// File › Import CMSIS-SVD…: read a device description, let the user pick
// registers, then add them as values (grouped into peripherals) or save them
// as templates.

import type { ValueCard } from "../../card/card";
import { ValueModel } from "../../core/model";
import {
  parseSvd,
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
  }
  if (opened.path) rememberDir(opened.path);
  const choice = await pickSvdRegisters(device, opened.name);
  if (!choice) return;
  if (choice.action === "templates") saveAsTemplates(choice.registers, device);
  else await addSvdValues(app, choice.registers, device);
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
async function addSvdValues(
  app: App,
  registers: SvdRegister[],
  device: SvdDevice,
) {
  const workspace = app.workspace;
  const deviceName = device.name;
  if (registers.length > 50) {
    const answer = await ask(
      "Add many values?",
      `This adds ${registers.length} values to the workspace. Large workspaces get slower to scroll and edit.`,
      [
        { id: "cancel", label: "Cancel" },
        {
          id: "yes",
          label: `Add ${registers.length} values`,
          className: "primary",
        },
      ],
    );
    if (answer !== "yes") return;
  }
  let firstCard: ValueCard | null = null;
  const blocks = new Map<string, string>(); // SVD peripheral → workspace peripheral
  app.history.hold(); // one undo step for the whole import
  try {
    for (const register of registers) {
      const source = device.peripherals.find(
        (peripheral) => peripheral.name === register.peripheral,
      )!;
      let block = blocks.get(source.name);
      if (!block) {
        const existing = workspace.peripherals.get(source.name);
        block =
          existing && existing.base === source.baseAddress
            ? source.name
            : freeName(source.name, (name) => workspace.peripherals.has(name));
        if (block !== source.name || !existing)
          workspace.peripherals.set(block, {
            name: block,
            base: source.baseAddress,
            description: source.description,
            collapsed: false,
          });
        blocks.set(source.name, block);
      }
      const model = new ValueModel({
        width: register.size,
        value: register.resetValue,
        name: register.path,
        view: appSettings.get("default_view"),
        defaultRowBase: appSettings.get("default_base"),
      });
      model.applyTemplate(registerTemplate(register, deviceName));
      model.setPeripheral(block, register.address - source.baseAddress);
      model.setDescription(register.description);
      const members = workspace.members(block);
      const index = members.length
        ? workspace.cards.indexOf(members[members.length - 1]) + 1
        : undefined;
      const card = workspace.addValue(model.width, model, index, false);
      firstCard ??= card;
    }
  } finally {
    app.history.release();
  }
  play("add");
  firstCard?.root.scrollIntoView({
    block: "start",
    behavior: "smooth",
  });
  toast(
    `Added ${registers.length} value${registers.length === 1 ? "" : "s"} from ${deviceName}`,
    "ok",
  );
}
