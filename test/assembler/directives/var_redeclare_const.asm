; Test .var directive - error case: redeclare constant as variable
; This should fail because CONST already exists as a constant

CONST = 5

CONST .var 10           ; Error: Cannot declare variable 'CONST' - already exists as a constant
