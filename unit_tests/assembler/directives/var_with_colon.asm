; Test .var directive with label-style colon syntax
.org 0x0200

Value: .var 0xFF
        db Value        ; Should emit 0xFF

Value = Value - 1       ; Update to 0xFE
        db Value        ; Should emit 0xFE
