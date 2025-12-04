; Test .var directive - error case: redeclare variable
; This should fail because MyVar already exists as a variable

MyVar .var 5

MyVar .var 10           ; Error: Cannot redeclare variable 'MyVar' - already exists as a variable
