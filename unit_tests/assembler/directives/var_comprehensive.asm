; Comprehensive test for .var directive functionality
.org 0x0100

; Test 1: Basic variable creation and usage
Counter .var 10
DB Counter              ; Should emit 10

; Test 2: Variable update with literal
Counter = 5
DB Counter              ; Should emit 5

; Test 3: Variable update with expression
Counter = Counter + 3
DB Counter              ; Should emit 8 (5 + 3)

; Test 4: Variable update with EQU
Counter EQU Counter * 2
DB Counter              ; Should emit 16 (8 * 2)

; Test 5: Variable used in expressions
Offset .var 0x20
DB Offset + 1           ; Should emit 0x21

; Test 6: Multiple variables
Var1 .var 100
Var2 .var 200
DB Var1                 ; Should emit 100
DB Var2                 ; Should emit 200
Var1 = 150
DB Var1                 ; Should emit 150
DB Var2                 ; Should emit 200 (unchanged)
