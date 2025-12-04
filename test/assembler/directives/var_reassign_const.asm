; Test .var directive - error case: reassign constant
; This should fail because CONST cannot be reassigned

CONST = 5

CONST = 10              ; Error: Cannot reassign constant 'CONST'
