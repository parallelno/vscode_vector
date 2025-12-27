; Test binary literal expressions when defining constants
.org 0x0100
MASK = %1111_0000
CONST = MASK + %0000_1010
DB CONST
