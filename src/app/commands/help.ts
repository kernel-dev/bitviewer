// Help menu: controls, guide, about, what's new, updates and the tour.

import {
  BookOpen,
  CircleQuestionMark,
  CloudDownload,
  Info,
  ScrollText,
  Sparkles,
} from "lucide";
import { showGuide } from "../../dialogs/guide";
import { showAbout, showHelp } from "../../dialogs/help";
import { showWhatsNew } from "../../dialogs/whats-new";
import { toast } from "../../ui/kit";
import type { App } from "../app";
import { checkForUpdates } from "../updates";
import type { Command } from "./registry";

export function helpCommands(app: App): Command[] {
  return [
    {
      id: "help.controls",
      group: "Help",
      label: "Controls & shortcuts",
      icon: CircleQuestionMark,
      keys: ["F1"],
      run: () =>
        showHelp(
          app.commands,
          () => app.runTour(),
          (page) => showGuide(page),
        ),
    },
    {
      id: "help.guide",
      group: "Help",
      label: "Guide",
      icon: BookOpen,
      keywords: "docs documentation manual how to tutorial",
      run: () => showGuide(),
    },
    {
      id: "help.about",
      group: "Help",
      label: "About Bit Viewer",
      icon: Info,
      run: () => showAbout(),
    },
    {
      id: "help.whatsnew",
      group: "Help",
      label: "What's new",
      icon: ScrollText,
      keywords: "changelog changes release notes version",
      run: async () => {
        if (!(await showWhatsNew())) toast("No release notes for this version");
      },
    },
    {
      id: "help.updates",
      group: "Help",
      label: "Check for updates…",
      icon: CloudDownload,
      keywords: "upgrade version new",
      run: () => checkForUpdates(true, () => app.document.prepareToQuit()),
    },
    {
      id: "help.tour",
      group: "Help",
      label: "Take the tour",
      icon: Sparkles,
      keywords: "introduction guide first",
      run: () => app.runTour(),
    },
    // swallow browser shortcuts that make no sense in an app window
    {
      id: "noop.browser",
      group: "Help",
      label: "",
      keys: ["Ctrl+R", "Ctrl+P", "F5"],
      hidden: true,
      run: () => {},
    },
  ];
}
