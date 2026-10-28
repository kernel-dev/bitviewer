// Writes the code export of a sample workspace with every built-in template,
// so the native app's exporter can be checked against this one byte for byte
// (native/core/tests/export_golden.rs). Runs only with WRITE_GOLDEN=1.

import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_EXPORTS,
  renderExport,
  renderPeripheralExport,
} from "../../src/core/export/codegen";
import { defaultPrefix } from "../../src/core/export/naming";
import { valueFromJSON } from "../../src/core/model/serialize";
import { parseSvd, registerTemplate } from "../../src/core/svd";
import { peripheralsFromJSON } from "../../src/core/workspace";

const FIXTURES = "native/core/tests/fixtures";

describe("export golden files", () => {
  it.skipIf(!process.env.WRITE_GOLDEN)("writes the golden outputs", () => {
    const file = JSON.parse(
      readFileSync(`${FIXTURES}/export-sample.bitview`, "utf8"),
    );
    const models = file.values.map((json: unknown) => valueFromJSON(json));
    const peripherals = peripheralsFromJSON(file.peripherals);
    const out: Record<string, string> = {};
    const attempt = (key: string, run: () => string) => {
      try {
        out[key] = run();
      } catch (error) {
        out[key] = `ERROR ${(error as Error).message}`;
      }
    };

    models.forEach((model: any, index: number) => {
      for (const template of BUILTIN_EXPORTS) {
        if (template.scope !== "register") continue;
        for (const platform of [32, 64] as const)
          for (const includeValue of [true, false])
            attempt(
              `${index}/${template.id}/${platform}/${includeValue}`,
              () =>
                renderExport(template.source, model, {
                  prefix: defaultPrefix(model),
                  includeValue,
                  platform,
                  peripheral: peripherals.get(model.block),
                }),
            );
      }
    });

    for (const peripheral of peripherals.values()) {
      const members = models.filter(
        (model: any) => model.block === peripheral.name,
      );
      for (const template of BUILTIN_EXPORTS) {
        if (template.scope !== "peripheral") continue;
        for (const includeValue of [true, false])
          attempt(`${peripheral.name}/${template.id}/${includeValue}`, () =>
            renderPeripheralExport(
              template.source,
              { peripheral, models: members },
              { prefix: peripheral.name, includeValue },
            ),
          );
      }
    }

    writeFileSync(`${FIXTURES}/export-golden.json`, JSON.stringify(out));
    expect(Object.keys(out).length).toBeGreaterThan(100);
  });

  it.skipIf(!process.env.WRITE_GOLDEN)("writes the SVD golden file", () => {
    const device = parseSvd(readFileSync(`${FIXTURES}/sample.svd`, "utf8"));
    const hex = (value: bigint) => `0x${value.toString(16)}`;
    const out = {
      name: device.name,
      description: device.description,
      warnings: device.warnings,
      peripherals: device.peripherals.map((peripheral) => ({
        name: peripheral.name,
        description: peripheral.description,
        groupName: peripheral.groupName,
        baseAddress: hex(peripheral.baseAddress),
        count: peripheral.count,
        registers: peripheral.registers.map((array) => ({
          label: array.label,
          description: array.description,
          size: array.size,
          count: array.count,
          copies: Array.from({ length: array.count }, (_, position) => {
            const register = array.at(position);
            const template = registerTemplate(register, device.name);
            return {
              path: register.path,
              name: register.name,
              peripheral: register.peripheral,
              peripheralBase: hex(register.peripheralBase),
              address: hex(register.address),
              access: register.access,
              resetValue: hex(register.resetValue),
              warnings: register.warnings,
              order: register.order,
              fields: register.fields.map((field) => ({
                name: field.name,
                description: field.description,
                lsb: field.lsb,
                msb: field.msb,
                access: field.access,
                enums: field.enums.map((item) => [hex(item.value), item.name, item.description]),
              })),
              template: {
                name: template.name,
                width: template.width,
                description: template.description ?? "",
                fields: template.fields.map((field) => ({
                  lo: field.lo,
                  hi: field.hi,
                  name: field.name,
                  color: field.color ?? "",
                  description: field.description ?? "",
                  access: field.access ?? "rw",
                  named: (field.named ?? []).map((item) => [item.value, item.label]),
                })),
              },
            };
          }),
        })),
      })),
    };
    writeFileSync(`${FIXTURES}/svd-golden.json`, JSON.stringify(out, null, 1));
    expect(out.peripherals.length).toBeGreaterThan(0);
  });
});
