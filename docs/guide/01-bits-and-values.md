# Bits and values

Every value is a row of 1 to 512 bits. Click a bit to flip it, or type a number into the field at the top in BIN, OCT, DEC or HEX.

![A 32-bit value with bits 15 to 8 selected](img/bits-selection.png)

## Selecting bits

- **Drag** across bits to select them. A selection can cross rows.
- **Shift+click** extends the selection.
- In byte or nibble layout, click a row label to select the whole row.
- With a selection, the toolbar shows an editor for just those bits, and operations like NOT and shifts act on the selection only.

## Typing numbers

- Pick the base with the BIN / OCT / DEC / HEX switch next to the field.
- The prefixes `0x`, `0b` and `0o` override the base. Spaces and `_` are ignored.
- The whole-value field accepts negative decimals and stores them as two's complement.
- Invalid input turns red with the reason in a tooltip. Press Esc to revert.

## Keyboard and paint mode

- Click a bit (or Tab to the bits) to place the cursor. Arrow keys move it, Space or Enter flips the bit, `0` and `1` set it, Shift+arrows select.
- Hold **Alt** and drag to set bits to 1. **Alt+Shift** and drag sets them to 0. One stroke is one undo step.

## Layout

Switch between one **Line**, one row per **Byte**, or one row per **Nibble** with the buttons at the left of the toolbar. **Bases** shows the value in all four bases at once.
