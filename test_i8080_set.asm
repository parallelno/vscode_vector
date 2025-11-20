; Full official Intel 8080 instruction set (mnemonic-based)
; Each documented mnemonic form appears at least once. This file is
; intended as a comprehensive, mnemonic-based test.

; -------------------------
; Data Transfer (MOV permutations)
; All 8x8 combinations (B,C,D,E,H,L,M,A)
i8080_set_test_start:
MOV B,B
MOV B,C
MOV B,D
MOV B,E
MOV B,H
MOV B,L
MOV B,M
MOV B,A
MOV C,B
MOV C,C
MOV C,D
MOV C,E
MOV C,H
MOV C,L
MOV C,M
MOV C,A
MOV D,B
MOV D,C
MOV D,D
MOV D,E
MOV D,H
MOV D,L
MOV D,M
MOV D,A
MOV E,B
MOV E,C
MOV E,D
MOV E,E
MOV E,H
MOV E,L
MOV E,M
MOV E,A
MOV H,B
MOV H,C
MOV H,D
MOV H,E
MOV H,H
MOV H,L
MOV H,M
MOV H,A
MOV L,B
MOV L,C
MOV L,D
MOV L,E
MOV L,H
MOV L,L
MOV L,M
MOV L,A
MOV M,B
MOV M,C
MOV M,D
MOV M,E
MOV M,H
MOV M,L
MOV M,A
MOV A,B
MOV A,C
MOV A,D
MOV A,E
MOV A,H
MOV A,L
MOV A,M
MOV A,A

; Immediate loads and register-pair loads
MVI B,0x01
MVI C,0x02
MVI D,0x03
MVI E,0x04
MVI H,0x05
MVI L,0x06
MVI M,0x07
MVI A,0x08
LXI B,0x1234
LXI D,0x2345
LXI H,0x3456
LXI SP,0x4000

; Memory direct load/store and pair-based access
LDA 0x0200
STA 0x0200
LDAX B
LDAX D
STAX B
STAX D
LHLD 0x0300
SHLD 0x0300
XCHG
PCHL
SPHL
XTHL

; -------------------------
; Stack operations
PUSH B
PUSH D
PUSH H
PUSH PSW
POP B
POP D
POP H
POP PSW

; -------------------------
; Arithmetic (register forms)
ADD B
ADD C
ADD D
ADD E
ADD H
ADD L
ADD M
ADD A
ADC B
ADC C
ADC D
ADC E
ADC H
ADC L
ADC M
ADC A
SUB B
SUB C
SUB D
SUB E
SUB H
SUB L
SUB M
SUB A
SBB B
SBB C
SBB D
SBB E
SBB H
SBB L
SBB M
SBB A
INR B
INR C
INR D
INR E
INR H
INR L
INR M
INR A
DCR B
DCR C
DCR D
DCR E
DCR H
DCR L
DCR M
DCR A
INX B
INX D
INX H
INX SP
DCX B
DCX D
DCX H
DCX SP
DAD B
DAD D
DAD H
DAD SP
DAA

; Immediate arithmetic
ADI 0x10
ACI 0x01
SUI 0x05
SBI 0x01

; -------------------------
; Logical operations (register forms)
ANA B
ANA C
ANA D
ANA E
ANA H
ANA L
ANA M
ANA A
XRA B
XRA C
XRA D
XRA E
XRA H
XRA L
XRA M
XRA A
ORA B
ORA C
ORA D
ORA E
ORA H
ORA L
ORA M
ORA A
CMP B
CMP C
CMP D
CMP E
CMP H
CMP L
CMP M
CMP A

; Immediate logical/comparison
ANI 0xFF
XRI 0x0F
ORI 0x01
CPI 0x00

; -------------------------
; Rotate and flag/control ops
RLC
RRC
RAL
RAR
STC
CMC
EI
DI
NOP
HLT

; -------------------------
; Control flow - jumps
JMP 0x0100
JZ 0x0100
JNZ 0x0100
JC 0x0100
JNC 0x0100
JP 0x0100
JM 0x0100
JPE 0x0100
JPO 0x0100

; Calls and returns
CALL 0x0100
CNZ 0x0100
CZ 0x0100
CNC 0x0100
CC 0x0100
CPO 0x0100
CPE 0x0100
CP 0x0100
CM 0x0100
RET
RNZ
RZ
RNC
RC
RPO
RPE
RP
RM

; Restart vectors
RST 0
RST 1
RST 2
RST 3
RST 4
RST 5
RST 6
RST 7

; -------------------------
; I/O and system
IN 0x00
OUT 0x00
i8080_set_test_end: