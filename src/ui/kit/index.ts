// Small UI kit: element builder, icons, buttons, segmented control, switch,
// popup menus, dialogs, tooltips, toasts and the validated number input.
// Import from here.

export { type Segmented, segmented, toggleSwitch } from "./controls";
export { append, button, html, icon } from "./dom";

export {
  closeMenus,
  installMenus,
  type MenuItem,
  menusOpen,
  openMenu,
} from "./menu";

export { ask, modal, modalOpen, prompt } from "./modal";
export { NumberInput } from "./number-input";
export { toast } from "./toast";
export { hideTip, installTooltips, setTip, showTip } from "./tooltip";
