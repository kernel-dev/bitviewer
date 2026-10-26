// The menu bar: which commands each menu shows, in order ("sep" = separator).
// Built each time a menu opens, so dynamic entries such as recent files are current.

import type { MenuItem } from "../../ui/kit";
import type { App } from "../app";

export function menuLayout(app: App): [string, (string | MenuItem)[]][] {
  return [
    [
      "File",
      [
        "file.new",
        "file.open",
        app.document.recentMenu(),
        "file.importSvd",
        "sep",
        "file.save",
        "file.saveAs",
        "sep",
        "file.quit",
      ],
    ],
    [
      "Edit",
      [
        "edit.undo",
        "edit.redo",
        "sep",
        "value.add32",
        "value.add64",
        "value.addCustom",
        "value.fromExpr",
        "value.fromTemplate",
        "sep",
        "sel.group",
        "sel.clear",
        "sep",
        "edit.find",
      ],
    ],
    [
      "View",
      [
        "view.zoomIn",
        "view.zoomOut",
        "view.zoomReset",
        "sep",
        "view.theme",
        "view.compact",
        "view.sounds",
        "sep",
        "app.settings",
      ],
    ],
    [
      "Help",
      [
        "app.palette",
        "help.controls",
        "help.guide",
        "help.whatsnew",
        "help.tour",
        "sep",
        "help.updates",
        "help.about",
      ],
    ],
  ];
}
