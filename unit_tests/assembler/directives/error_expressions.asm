; Test that .error can include expressions and labels
        .org 0x2000
VALUE = 0x1234
ADDR = 0x2000
        .error "Value is", VALUE, ", address is", ADDR
