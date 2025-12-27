; Test binary literal expressions when initializing variables
.org 0x0100
Value .var %0011_1100 | %0000_0011
DB Value
Value = Value + %0001_0000
DB Value
