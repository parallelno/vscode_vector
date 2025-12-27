.macro EmitConst(val)
C = val
DB C
.endmacro

C = 9

EmitConst(1)
EmitConst(5)
DB C
