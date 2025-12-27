; Validate binary literals, relational and shift operators in data directives
.org 0x0100

CONST1 = %00_0_11
DB (CONST1 + CONST1) > 1
DW (CONST1 * CONST1) < CONST1
DB CONST1 + (CONST1<<1)
DW CONST1 * (CONST1 + CONST1 << CONST1)
