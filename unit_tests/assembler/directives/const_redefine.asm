; Test that constants cannot be redefined
.org 0x0600

VALUE = 10
        db VALUE        ; Emit 10

VALUE = 20              ; Should fail - cannot redefine constant
        db VALUE
