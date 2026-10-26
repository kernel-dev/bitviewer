// The pieces of the export template language: errors, numbers as templates
// see them, metadata, and the syntax tree that compile.ts builds.

export class TemplateError extends Error {
  constructor(
    readonly reason: string,
    readonly line = 0,
  ) {
    super(line ? `Line ${line}: ${reason}` : reason);
  }
}

/** A number a template can print in several spellings. `${x}` prints it as hex; `${x.bin}`, `.dec` and `.oct` are there too. */
export class Num {
  readonly #big: bigint; // private, so templates only see hex, bin, dec and oct

  constructor(
    big: bigint,
    readonly hex: string,
    readonly bin: string,
    readonly dec: string,
    readonly oct: string,
  ) {
    this.#big = big;
  }

  get big(): bigint {
    return this.#big;
  }

  /** `bits` is how many binary digits to pad to. */
  static of(value: bigint, bits: number): Num {
    return new Num(
      value,
      `0x${value.toString(16).toUpperCase()}`,
      `0b${value.toString(2).padStart(bits, "0")}`,
      value.toString(10),
      `0o${value.toString(8)}`,
    );
  }
}

export type TemplateScope = "register" | "peripheral";

export interface TemplateMeta {
  name?: string;
  extension?: string;
  about?: string;

  /** "register": one value; "peripheral": a block of registers. */
  scope?: TemplateScope;
}

export type Ex =
  | { kind: "lit"; value: string | number | boolean }
  | { kind: "path"; path: string[] }
  | { kind: "not" | "neg"; operand: Ex }
  | { kind: "bin"; operator: string; left: Ex; right: Ex }
  | { kind: "filter"; input: Ex; name: string; argumentExpressions: Ex[] };

export type Part = string | { expression: Ex };

export type Node =
  | { kind: "text"; line: number; parts: Part[] }
  | {
      kind: "for";
      line: number;
      variable: string;
      list: Ex;
      body: Node[];
      orelse: Node[];
    }
  | { kind: "if"; line: number; branches: { cond: Ex | null; body: Node[] }[] }
  | { kind: "set"; line: number; name: string; expression: Ex };

export interface Compiled {
  meta: TemplateMeta;
  body: Node[];
}
