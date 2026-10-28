import { describe, expect, it } from "vitest";
import { ValueModel } from "../../src/core/model";
import {
  IndexSet,
  inFileOrder,
  parseSvd,
  parseSvdNumber,
  pickedRegisters,
  registerTemplate,
  type SvdDevice,
  SvdError,
  type SvdRegister,
} from "../../src/core/svd";
import { parseXml, XmlError } from "../../src/core/svd/xml";

describe("xml", () => {
  it("reads elements, attributes, text, entities and CDATA", () => {
    const root = parseXml(`<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE note [ <!ENTITY x "y"> ]>
<!-- a comment -->
<a x="1" y='two &amp; three'>
  <b>Tom &lt;&amp;&gt; Jerry &#65;&#x42;</b>
  <c/>
  <d><![CDATA[<raw> & stuff]]></d>
</a>`);
    expect(root.name).toBe("a");
    expect(root.attributes).toEqual({ x: "1", y: "two & three" });
    expect(root.children.map((element) => element.name)).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(root.children[0].text).toBe("Tom <&> Jerry AB");
    expect(root.children[2].text).toBe("<raw> & stuff");
  });

  it("reports mistakes with line numbers", () => {
    expect(() => parseXml("<a>\n<b>\n</a>")).toThrow("Line 3: </a> closes <b>");
    expect(() => parseXml("<a>\n<b>")).toThrow(/<b> is never closed/);
    expect(() => parseXml("<a>&nope;</a>")).toThrow(XmlError);
    expect(() => parseXml("<a/><b/>")).toThrow(/second root/);
  });
});

describe("svd numbers", () => {
  it("reads hex, binary, decimal and size suffixes", () => {
    expect(parseSvdNumber("0x1F")).toBe(31n);
    expect(parseSvdNumber("0X1f")).toBe(31n);
    expect(parseSvdNumber("#101")).toBe(5n);
    expect(parseSvdNumber("0b101")).toBe(5n);
    expect(parseSvdNumber(" 42 ")).toBe(42n);
    expect(parseSvdNumber("4k")).toBe(4096n);
    expect(parseSvdNumber("nope")).toBeNull();
  });
});

/** Every copy of every register, as an import of everything would make them. */
const everyRegister = (device: SvdDevice): SvdRegister[] =>
  device.peripherals.flatMap((peripheral) =>
    peripheral.registers.flatMap((array) =>
      Array.from({ length: array.count }, (_, position) => array.at(position)),
    ),
  );

const SVD = `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance">
  <name>DEMO</name>
  <description>Demo   chip &amp; friends</description>
  <size>32</size>
  <access>read-write</access>
  <resetValue>0x00000000</resetValue>
  <resetMask>0xFFFFFFFF</resetMask>
  <peripherals>
    <peripheral>
      <name>UART0</name>
      <groupName>UART</groupName>
      <baseAddress>0x40001000</baseAddress>
      <registers>
        <register>
          <name>CTRL</name>
          <description>Control register</description>
          <addressOffset>0x0</addressOffset>
          <resetValue>0x00000301</resetValue>
          <fields>
            <field>
              <name>EN</name>
              <description>Enable</description>
              <bitOffset>0</bitOffset>
              <bitWidth>1</bitWidth>
            </field>
            <field>
              <name>MODE</name>
              <bitRange>[9:8]</bitRange>
              <enumeratedValues>
                <name>ModeValues</name>
                <enumeratedValue><name>Off</name><value>0</value></enumeratedValue>
                <enumeratedValue><name>Auto</name><value>#1x</value></enumeratedValue>
                <enumeratedValue><name>Other</name><isDefault>true</isDefault></enumeratedValue>
              </enumeratedValues>
            </field>
            <field>
              <name>STATUS</name>
              <lsb>16</lsb><msb>19</msb>
              <access>read-only</access>
            </field>
            <field>
              <name>CLASH</name>
              <lsb>8</lsb><msb>8</msb>
            </field>
            <field>
              <name>RESERVED</name>
              <bitRange>[31:28]</bitRange>
            </field>
            <field>
              <name>OUTSIDE</name>
              <bitOffset>40</bitOffset><bitWidth>1</bitWidth>
            </field>
          </fields>
        </register>
        <register>
          <dim>2</dim>
          <dimIncrement>4</dimIncrement>
          <name>DATA%s</name>
          <addressOffset>0x10</addressOffset>
          <size>16</size>
          <access>read-only</access>
          <resetValue>0xFFFF</resetValue>
          <resetMask>0x00FF</resetMask>
        </register>
        <register>
          <dim>3</dim>
          <dimIncrement>4</dimIncrement>
          <dimIndex>A-C</dimIndex>
          <name>BUF[%s]</name>
          <addressOffset>0x20</addressOffset>
          <fields>
            <field>
              <name>BYTE%s</name>
              <dim>4</dim>
              <dimIncrement>8</dimIncrement>
              <bitOffset>0</bitOffset><bitWidth>8</bitWidth>
            </field>
          </fields>
        </register>
        <register derivedFrom="CTRL">
          <name>CTRL2</name>
          <addressOffset>0x40</addressOffset>
        </register>
        <cluster>
          <dim>2</dim>
          <dimIncrement>0x10</dimIncrement>
          <name>CH%s</name>
          <addressOffset>0x100</addressOffset>
          <register>
            <name>CFG</name>
            <addressOffset>0x4</addressOffset>
            <fields>
              <field>
                <name>SPEED</name>
                <bitOffset>0</bitOffset><bitWidth>2</bitWidth>
                <enumeratedValues derivedFrom="ModeValues"/>
              </field>
            </fields>
          </register>
        </cluster>
      </registers>
    </peripheral>
    <peripheral derivedFrom="UART0">
      <name>UART1</name>
      <baseAddress>0x40002000</baseAddress>
    </peripheral>
    <peripheral>
      <name>WIDE</name>
      <baseAddress>0x50000000</baseAddress>
      <registers>
        <register><name>HUGE</name><addressOffset>0</addressOffset><size>1024</size></register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

describe("svd", () => {
  const device = parseSvd(SVD);
  const uart0 = device.peripherals.find((item) => item.name === "UART0")!;
  const register = (path: string) =>
    everyRegister(device).find((item) => item.path === path)!;

  it("reads the device and its peripherals", () => {
    expect(device.name).toBe("DEMO");
    expect(device.description).toBe("Demo chip & friends");
    expect(device.peripherals.map((item) => item.name)).toEqual([
      "UART0",
      "UART1",
      "WIDE",
    ]);
    expect(uart0.groupName).toBe("UART");
    expect(uart0.baseAddress).toBe(0x40001000n);
  });

  it("reads fields in all three bit notations, and enumerated values", () => {
    const ctrl = register("UART0.CTRL");
    expect(ctrl.address).toBe(0x40001000n);
    expect(ctrl.resetValue).toBe(0x301n);
    expect(ctrl.description).toBe("Control register");
    const fields = Object.fromEntries(
      ctrl.fields.map((field) => [field.name, field]),
    );
    expect(Object.keys(fields)).toEqual(["EN", "MODE", "STATUS", "RESERVED"]);
    expect([fields.MODE.lsb, fields.MODE.msb]).toEqual([8, 9]);
    expect([fields.STATUS.lsb, fields.STATUS.msb]).toEqual([16, 19]);
    expect(fields.STATUS.access).toBe("read-only");
    expect(fields.EN.access).toBe("read-write");
    // #1x is 2 and 3; the isDefault entry has no value
    expect(fields.MODE.enums.map((item) => [item.value, item.name])).toEqual([
      [0n, "Off"],
      [2n, "Auto"],
      [3n, "Auto"],
    ]);
    expect(ctrl.warnings).toEqual([
      "CLASH overlaps MODE, so it was left out",
      "OUTSIDE [40:40] is outside the 32-bit register",
    ]);
  });

  it("expands dim arrays of registers and fields", () => {
    expect(register("UART0.DATA0").address).toBe(0x40001010n);
    expect(register("UART0.DATA1").address).toBe(0x40001014n);
    expect(register("UART0.DATA1").size).toBe(16);
    expect(register("UART0.DATA1").resetValue).toBe(0xffn); // reset mask
    const bufC = register("UART0.BUFC");
    expect(bufC.address).toBe(0x40001028n);
    expect(bufC.fields.map((field) => [field.name, field.lsb])).toEqual([
      ["BYTE0", 0],
      ["BYTE1", 8],
      ["BYTE2", 16],
      ["BYTE3", 24],
    ]);
  });

  it("follows derivedFrom and flattens clusters", () => {
    const ctrl2 = register("UART0.CTRL2");
    expect(ctrl2.address).toBe(0x40001040n);
    expect(ctrl2.fields.map((field) => field.name)).toContain("MODE");
    expect(register("UART1.CTRL").address).toBe(0x40002000n);
    const cfg = register("UART0.CH1.CFG");
    expect(cfg.address).toBe(0x40001114n);
    expect(cfg.fields[0].enums.map((item) => item.name)).toEqual([
      "Off",
      "Auto",
      "Auto",
    ]);
  });

  it("skips registers wider than Bit Viewer allows", () => {
    expect(
      device.peripherals.find((item) => item.name === "WIDE")!.registers,
    ).toEqual([]);
    expect(device.warnings).toContain(
      "WIDE.HUGE: 1024 bits is outside 1–512; skipped",
    );
  });

  it("turns a register into a template the model accepts", () => {
    const template = registerTemplate(register("UART0.CTRL"), device.name);
    expect(template.name).toBe("DEMO UART0.CTRL");
    expect(template.description).toBe(
      "0x40001000 · Control register · reset 0x301",
    );
    const model = new ValueModel({ width: template.width, value: 0x301n });
    model.applyTemplate(template);
    const byName = Object.fromEntries(
      model.groups.map((group) => [group.name, group]),
    );
    expect(byName.STATUS.access).toBe("ro");
    expect(byName.RESERVED.access).toBe("reserved");
    expect(byName.EN.description).toBe("Enable");
    expect(byName.MODE.nameOf(model.groupValue(byName.MODE))).toBe("Auto");
  });

  it("rejects files that aren't SVD", () => {
    expect(() => parseSvd("<workspace/>")).toThrow(SvdError);
  });
});

/** A device with one peripheral around `registers`. */
const deviceWith = (registers: string, peripheral = "<name>P</name>") =>
  parseSvd(`<device><name>D</name><peripherals><peripheral>
    ${peripheral}<baseAddress>0x40000000</baseAddress>
    <registers>${registers}</registers>
  </peripheral></peripherals></device>`);

describe("svd arrays", () => {
  it("keeps each array as one entry", () => {
    const uart0 = parseSvd(SVD).peripherals[0];
    expect(uart0.registers.map((array) => [array.label, array.count])).toEqual([
      ["CTRL", 1],
      ["DATA[0-1]", 2],
      ["BUF[A-C]", 3],
      ["CTRL2", 1],
      ["CH[0-1].CFG", 2],
    ]);
  });

  it("reads arrays of any size, nested in peripherals and clusters", () => {
    const device = deviceWith(
      `<cluster>
         <name>CH%s</name><dim>1000</dim><dimIncrement>0x100</dimIncrement>
         <addressOffset>0x1000</addressOffset>
         <register><name>R%s</name><dim>64</dim><dimIncrement>4</dimIncrement><addressOffset>0</addressOffset></register>
       </cluster>
       <register><name>BIG%s</name><dim>4G</dim><dimIncrement>4</dimIncrement><addressOffset>0</addressOffset></register>`,
      `<name>TIM%s</name><dim>2</dim><dimIncrement>0x100000</dimIncrement><dimIndex>2-3</dimIndex>`,
    );
    const [timers] = device.peripherals;
    expect([timers.name, timers.count]).toEqual(["TIM[2-3]", 2]);

    const [channels, big] = timers.registers;
    expect([channels.label, channels.count]).toEqual([
      "CH[0-999].R[0-63]",
      128_000,
    ]);
    expect(channels.at(64).path).toBe("TIM2.CH1.R0");
    const last = channels.at(channels.count - 1);
    expect(last.path).toBe("TIM3.CH999.R63");
    expect(last.peripheral).toBe("TIM3");
    expect(last.peripheralBase).toBe(0x40100000n);
    expect(last.address).toBe(0x40100000n + 0x1000n + 999n * 0x100n + 63n * 4n);

    expect(big.count).toBe(2 * 4 * 1024 ** 3);
    expect(big.at(big.count - 1).path).toBe("TIM3.BIG4294967295");
    expect(() => big.at(big.count)).toThrow(RangeError);
  });

  it("skips arrays too large to count", () => {
    const device = deviceWith(
      `<register><name>A%s</name><dim>99999999999999999999</dim><addressOffset>0</addressOffset></register>
       <cluster><name>C%s</name><dim>1T</dim><addressOffset>0</addressOffset>
         <register><name>B%s</name><dim>1T</dim><addressOffset>0</addressOffset></register>
       </cluster>`,
    );
    expect(device.peripherals[0].registers).toEqual([]);
    expect(device.warnings).toEqual([
      "P.A%s: dim 99999999999999999999 is too large to count; skipped",
      `P.C[0-1099511627775].B[0-1099511627775]: ${1024n ** 8n} copies are too many to count; skipped`,
    ]);
  });

  it("only makes the field copies that fit in the register", () => {
    const [array] = deviceWith(
      `<register><name>R</name><addressOffset>0</addressOffset><size>32</size><fields>
         <field><name>B%s</name><dim>1000000</dim><dimIncrement>1</dimIncrement><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
       </fields></register>
       <register><name>S</name><addressOffset>4</addressOffset><fields>
         <field><name>F%s</name><dim>5</dim><dimIncrement>0</dimIncrement><bitOffset>0</bitOffset><bitWidth>1</bitWidth></field>
       </fields></register>`,
    ).peripherals[0].registers;
    expect(array.fields.map((field) => field.name)).toEqual(
      Array.from({ length: 32 }, (_, index) => `B${index}`),
    );
    expect(array.warnings).toEqual([
      "B[0-999999]: 999968 more copies would be outside the 32-bit register, so they were left out",
    ]);
  });

  it("numbers copies when dimIndex doesn't fit the dim", () => {
    const device = deviceWith(
      `<register><name>L%s</name><dim>30</dim><dimIndex>A-Z</dimIndex><addressOffset>0</addressOffset></register>
       <register><name>N%s</name><dim>3</dim><dimIndex>0-7</dimIndex><addressOffset>0</addressOffset></register>
       <register><name>W%s</name><dim>3</dim><dimIndex>a,b</dimIndex><addressOffset>0</addressOffset></register>
       <register><name>OK%s</name><dim>3</dim><dimIndex>x, y ,z</dimIndex><addressOffset>0</addressOffset></register>`,
    );
    const [letters, numbers, short, list] = device.peripherals[0].registers;
    expect(letters.label).toBe("L[0-29]");
    expect(letters.at(29).name).toBe("L29");
    expect(numbers.label).toBe("N[0-2]");
    expect(short.at(2).name).toBe("W2");
    expect(list.label).toBe("OK[x,y,z]");
    expect(list.at(1).name).toBe("OKy");
    expect(device.warnings).toEqual([
      "P.L%s: dimIndex A-Z runs out of letters for dim 30; numbered 0-29",
      "P.N%s: dimIndex 0-7 doesn't match dim 3; numbered from 0",
      "P.W%s: dimIndex lists 2 names for dim 3; numbered 0-2",
    ]);
  });

  it("puts picked copies back in file order", () => {
    const [cfg, stat] = deviceWith(
      `<cluster><name>CH%s</name><dim>2</dim><dimIncrement>8</dimIncrement><addressOffset>0</addressOffset>
         <register><name>CFG</name><addressOffset>0</addressOffset></register>
         <register><name>STAT</name><addressOffset>4</addressOffset></register>
       </cluster>`,
    ).peripherals[0].registers;
    const picks = [
      { array: cfg, positions: IndexSet.all(2) },
      { array: stat, positions: IndexSet.all(2) },
    ];
    expect(pickedRegisters(picks).map((register) => register.path)).toEqual([
      "P.CH0.CFG",
      "P.CH0.STAT",
      "P.CH1.CFG",
      "P.CH1.STAT",
    ]);
    expect(
      inFileOrder([stat.at(0), cfg.at(1)]).map((item) => item.path),
    ).toEqual(["P.CH0.STAT", "P.CH1.CFG"]);
  });
});

describe("index sets", () => {
  it("reads, merges and writes positions", () => {
    const set = IndexSet.parse("8, 0-3 2 - 5", 10) as IndexSet;
    expect(set.toString()).toBe("0-5, 8");
    expect(set.size).toBe(7);
    expect([...set]).toEqual([0, 1, 2, 3, 4, 5, 8]);
    set.set(3, false);
    set.set(9, true);
    expect(set.toString()).toBe("0-2, 4-5, 8-9");
    expect(set.has(4)).toBe(true);
    expect(set.has(3)).toBe(false);
    set.fill(false);
    expect(set.size).toBe(0);
    expect((IndexSet.parse("", 4) as IndexSet).size).toBe(0);
  });

  it("explains positions it can't take", () => {
    expect(IndexSet.parse("4", 4)).toBe("4 is past the last copy (3)");
    expect(IndexSet.parse("3-1", 4)).toBe("3-1 runs backwards");
    expect(IndexSet.parse("x", 4)).toMatch(/not a position/);
  });

  it("holds billions of positions as one range", () => {
    const set = IndexSet.all(2 ** 40);
    set.set(5, false);
    expect(set.size).toBe(2 ** 40 - 1);
    expect(set.toString()).toBe(`0-4, 6-${2 ** 40 - 1}`);
  });
});
