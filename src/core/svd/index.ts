// CMSIS-SVD import. Import from here.

export { parseSvd } from "./reader";
export { hexAddress, registerTemplate } from "./template";

export type {
  SvdDevice,
  SvdEnum,
  SvdField,
  SvdPeripheral,
  SvdRegister,
} from "./types";

export { SvdError } from "./types";
export { parseSvdNumber } from "./values";
