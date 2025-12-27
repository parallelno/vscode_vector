.macro Spin(val)
@loop:
  DB val
  JMP @loop
.endmacro

Spin(1)
Spin(2)
