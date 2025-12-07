; Test basic .var directive
.org 0x0100
Counter .var 10
DB Counter      ; Emit initial value (10)
Counter = 5
DB Counter      ; Emit updated value (5)
