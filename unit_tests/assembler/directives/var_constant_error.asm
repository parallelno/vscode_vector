; Test that constants cannot be reassigned
.org 0x0100
CONST = 42
CONST = 50      ; Should error: cannot reassign constant
