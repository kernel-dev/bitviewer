import { describe, expect, it } from "vitest";
import {
  BUILTIN_EXPORTS,
  generate,
  renderPeripheralExport,
} from "../../src/core/export/codegen";
import {
  ModelError,
  ValueModel,
  valueFromJSON,
  valueToJSON,
} from "../../src/core/model";
import {
  addressOf,
  freeName,
  groupOrder,
  moveBlock,
  moveItem,
  nextOffset,
  type Peripheral,
  peripheralFromJSON,
  peripheralsFromJSON,
  peripheralToJSON,
} from "../../src/core/workspace";

// items are "name" or "block:name"
const blockOf = (item: string) =>
  item.includes(":") ? item.split(":")[0] : "";

describe("workspace order", () => {
  it("keeps a peripheral's values together where it first appears", () => {
    expect(groupOrder(["a", "U:1", "b", "U:2", "c"], blockOf)).toEqual([
      "a",
      "U:1",
      "U:2",
      "b",
      "c",
    ]);
  });

  it("moves a register only within its peripheral", () => {
    const items = ["a", "U:1", "U:2", "U:3", "b"];
    expect(moveItem(items, 1, 2, blockOf)).toEqual([
      "a",
      "U:2",
      "U:1",
      "U:3",
      "b",
    ]);
    expect(moveItem(items, 1, 99, blockOf)).toEqual([
      "a",
      "U:2",
      "U:3",
      "U:1",
      "b",
    ]);
    expect(moveItem(items, 3, 0, blockOf)).toEqual([
      "a",
      "U:3",
      "U:1",
      "U:2",
      "b",
    ]);
  });

  it("never drops a loose value into the middle of a peripheral", () => {
    const items = ["a", "U:1", "U:2", "b"];
    expect(moveItem(items, 0, 2, blockOf)).toEqual(["U:1", "U:2", "a", "b"]);
    expect(moveItem(items, 3, 1, blockOf)).toEqual(["a", "b", "U:1", "U:2"]);
    // moving up into a peripheral jumps over it
    expect(moveItem(items, 3, 2, blockOf)).toEqual(["a", "b", "U:1", "U:2"]);
    expect(moveItem(["U:1", "U:2", "a"], 2, 1, blockOf)).toEqual([
      "a",
      "U:1",
      "U:2",
    ]);
  });

  it("moves a whole peripheral past its neighbour", () => {
    const items = ["a", "U:1", "U:2", "V:1", "b"];
    expect(moveBlock(items, "U", -1, blockOf)).toEqual([
      "U:1",
      "U:2",
      "a",
      "V:1",
      "b",
    ]);
    expect(moveBlock(items, "U", 1, blockOf)).toEqual([
      "a",
      "V:1",
      "U:1",
      "U:2",
      "b",
    ]);
    expect(moveBlock(["U:1", "a"], "U", -1, blockOf)).toEqual(["U:1", "a"]);
  });
});

describe("peripherals", () => {
  it("round-trip through JSON and reject bad entries", () => {
    const uart: Peripheral = {
      name: "UART0",
      base: 0x40011000n,
      description: "Serial port",
      collapsed: true,
    };
    expect(peripheralToJSON(uart)).toEqual({
      name: "UART0",
      base: "0x40011000",
      description: "Serial port",
      collapsed: true,
    });
    expect(peripheralFromJSON(peripheralToJSON(uart))).toEqual(uart);
    expect(peripheralFromJSON({ name: "X", base: null }).base).toBeNull();
    expect(() => peripheralFromJSON({ name: "" })).toThrow(ModelError);
    expect(() => peripheralFromJSON({ name: "X", base: "nope" })).toThrow(
      ModelError,
    );
    expect(() => peripheralsFromJSON({})).toThrow(ModelError);
    expect(peripheralsFromJSON(undefined).size).toBe(0);
  });

  it("works out offsets, addresses and free names", () => {
    expect(
      nextOffset([
        { offset: 0n, width: 32 },
        { offset: 4n, width: 16 },
        { offset: null, width: 32 },
      ]),
    ).toBe(8n);
    expect(nextOffset([])).toBe(0n);
    const uart = {
      name: "U",
      base: 0x1000n,
      description: "",
      collapsed: false,
    };
    expect(addressOf(0x8n, uart)).toBe(0x1008n);
    expect(addressOf(null, uart)).toBeNull();
    expect(addressOf(0x8n, { ...uart, base: null })).toBeNull();
    expect(
      freeName("UART0", (name) => ["UART0", "UART0 (2)"].includes(name)),
    ).toBe("UART0 (3)");
  });

  it("keeps a value's peripheral, offset and description in JSON", () => {
    const model = new ValueModel({ width: 32, name: "UART0.CTRL" });
    model.setPeripheral("UART0", 0x10n);
    model.setDescription("Control");
    const copy = valueFromJSON(JSON.parse(JSON.stringify(valueToJSON(model))));
    expect([copy.block, copy.offset, copy.description]).toEqual([
      "UART0",
      0x10n,
      "Control",
    ]);
    // plain values don't grow new keys
    expect(Object.keys(valueToJSON(new ValueModel()))).not.toContain("block");
    expect(() => model.setPeripheral("UART0", -1n)).toThrow(ModelError);
  });
});

describe("peripheral export", () => {
  const target = () => {
    const make = (name: string, width: number, offset: bigint | null) => {
      const model = new ValueModel({ width, name, value: 0x5n });
      model.setPeripheral("UART0", offset);
      return model;
    };

    const ctrl = make("UART0.CTRL", 32, 0x0n);
    ctrl.setDescription("Control register");
    ctrl.addGroup(0, 0, "EN");
    return {
      peripheral: {
        name: "UART0",
        base: 0x40011000n,
        description: "Serial port",
        collapsed: false,
      },
      models: [
        make("UART0.DATA", 8, 0x8n),
        ctrl,
        make("UART0.BAUD", 16, 0x4n),
        make("UART0.ALIAS", 32, 0x4n), // starts inside BAUD + padding
        make("UART0.WIDE", 96, 0x10n),
        make("UART0.LOOSE", 32, null),
      ],
    };
  };

  const source = (id: string) =>
    BUILTIN_EXPORTS.find((template) => template.id === id)!.source;

  it("lists the peripheral templates with their scope", () => {
    expect(
      BUILTIN_EXPORTS.filter((template) => template.scope === "peripheral").map(
        (template) => template.id,
      ),
    ).toEqual(["cperipheral", "cperipheralmacros", "rustperipheral"]);
  });

  it("lays registers out in a C struct with padding and checks", () => {
    const text = renderPeripheralExport(source("cperipheral"), target(), {
      prefix: "UART0",
      includeValue: false,
    });
    const members = text
      .split("\n")
      .filter((line) => /^\s+(volatile|uint8_t)/.test(line))
      .map((line) => line.trim().replace(/\s+/g, " "));
    expect(members).toEqual([
      "volatile uint32_t CTRL; /* 0x0 Control register */",
      "volatile uint16_t BAUD; /* 0x4 */",
      "uint8_t RESERVED0[2]; /* 0x6–0x7 unused */",
      "volatile uint8_t DATA; /* 0x8 */",
      "uint8_t RESERVED1[7]; /* 0x9–0xF unused */",
      "volatile uint32_t WIDE[3]; /* 0x10 */",
    ]);
    expect(text).toContain(
      "/* ALIAS at offset 0x4 overlaps the register before it",
    );
    expect(text).toContain(
      '_Static_assert(offsetof(uart0_t, WIDE) == 0x10, "WIDE is at offset 0x10");',
    );
    expect(text).toContain("#define UART0_BASE 0x40011000UL");
    expect(text).toContain("#define UART0 ((uart0_t *)UART0_BASE)");
    expect(text).toContain("no offset: LOOSE");
  });

  it("writes base, offsets and addresses as #defines", () => {
    const text = renderPeripheralExport(source("cperipheralmacros"), target(), {
      prefix: "UART0",
      includeValue: true,
    });
    expect(text).toContain("#define UART0_BAUD_OFFSET 0x4U");
    expect(text).toContain(
      "#define UART0_BAUD_ADDR   (UART0_BASE + UART0_BAUD_OFFSET)",
    );
    expect(text).toContain("#define UART0_CTRL_VALUE  0x5U");
    expect(text).not.toContain("WIDE_VALUE"); // 96 bits don't fit a C integer
  });

  it("gives single-register exports the address too", () => {
    const { peripheral, models } = target();
    const ctrl = models[1];
    const options = { prefix: "UART0_CTRL", includeValue: false, peripheral };
    expect(generate("c", ctrl, options)).toContain(
      "#define UART0_CTRL_ADDR 0x40011000U",
    );
    expect(generate("rust", ctrl, options)).toContain(
      "pub const ADDR: usize = 0x40011000;",
    );
    expect(generate("python", ctrl, options)).toContain(
      "UART0_CTRL_ADDR = 0x40011000",
    );
    expect(
      generate("c", ctrl, { prefix: "X", includeValue: false }),
    ).not.toContain("_ADDR");
  });
});

describe("peripheral template in the guide", () => {
  it("renders the example from 07-export-templates.md", () => {
    const model = new ValueModel({ width: 32, name: "UART0.CTRL" });
    model.setPeripheral("UART0", 0n);
    const data = new ValueModel({ width: 8, name: "UART0.DATA" });
    data.setPeripheral("UART0", 6n);
    const source = [
      "@scope peripheral",
      "typedef struct {",
      "@for item in layout",
      "@if item.gap",
      "  uint8_t  ${item.declaration};",
      "@elif item.member",
      "  volatile ${item.type} ${item.declaration};",
      "@end",
      "@end",
      "} ${prefix | lower}_t;",
    ].join("\n");
    expect(
      renderPeripheralExport(
        source,
        {
          peripheral: {
            name: "UART0",
            base: null,
            description: "",
            collapsed: false,
          },
          models: [model, data],
        },
        { prefix: "UART0", includeValue: false },
      ),
    ).toBe(
      "typedef struct {\n  volatile uint32_t CTRL;\n  uint8_t  RESERVED0[2];\n  volatile uint8_t DATA;\n} uart0_t;\n",
    );
  });
});
