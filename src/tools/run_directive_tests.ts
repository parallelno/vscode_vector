#!/usr/bin/env node
/**
 * run_directive_tests.ts
 *
 * Regression harness for assembler directive coverage.
 * Each test assembles a fixture from unit_tests/assembler/directives
 * and validates the produced bytes, labels, maps, warnings, and prints
 * against declarative expectations.
 *
 * Test definitions specify:
 * - Source .asm file to assemble
 * - Expected bytes, labels, line-address map entries, and print output
 * - Required substrings in warnings/errors or the absence of warnings
 *
 * Usage: npm run test-directives
 */

import * as fs from 'fs';
import * as path from 'path';
import { assemble } from '../assembler';
import { AssembleResult } from '../assembler/types';

type DirectiveTestExpectations = {
    success?: boolean;
    bytes?: number[];
    labels?: Record<string, number>;
    consts?: Record<string, number>;
    map?: Record<number, number>;
    warningsContains?: string[];
    errorsContains?: string[];
    noWarnings?: boolean;
    printMessages?: string[];
};

type DirectiveTestCase = {
    name: string;
    sourceFile: string;
    description?: string;
    expect: DirectiveTestExpectations;
};

type DirectiveTestResult = {
    name: string;
    durationMs: number;
    passed: boolean;
    details: string[];
};

const repoRoot = path.resolve(__dirname, '..', '..');
const directivesDir = path.join(repoRoot, 'unit_tests', 'assembler', 'directives');

const tests: DirectiveTestCase[] = [
    {
        name: '.org resets addresses',
        sourceFile: 'org_basic.asm',
        expect: {
            bytes: [0x00, 0x12, 0x00],
            labels: {
                start: 0x0100,
                second: 0x0200
            }
        }
    },
    {
        name: '.align advances to power-of-two boundary',
        sourceFile: 'align_basic.asm',
        expect: {
            bytes: [0xAA, 0x00, 0x00, 0x00, 0x00, 0xFF],
            labels: {
                aligned_label: 0x0008
            }
        }
    },
    {
        name: '.align rejects non power-of-two',
        sourceFile: 'align_invalid.asm',
        expect: {
            success: false,
            errorsContains: ['.align value must be a power of two']
        }
    },
    {
        name: '.if gates assembly blocks',
        sourceFile: 'if_basic.asm',
        expect: {
            bytes: [0x0F, 0xBB],
            labels: {
                true_block: 0x0080
            }
        }
    },
    {
        name: '.if requires matching .endif',
        sourceFile: 'if_missing_endif.asm',
        expect: {
            success: false,
            errorsContains: ['Missing .endif']
        }
    },
    {
        name: '.loop repeats body the requested number of times',
        sourceFile: 'loop_basic.asm',
        expect: {
            bytes: [0x22, 0x22, 0x22]
        }
    },
    {
        name: '.loop requires matching .endloop',
        sourceFile: 'loop_missing_endloop.asm',
        expect: {
            success: false,
            errorsContains: ['Missing .endloop']
        }
    },
    {
        name: '.include pulls in sibling files',
        sourceFile: 'include_main.asm',
        expect: {
            bytes: [0x44, 0x55],
            labels: {
                child_label: 0x0040,
                after_include: 0x0041
            }
        }
    },
    {
        name: '.include resolves nested relative paths',
        sourceFile: 'include_nested_root.asm',
        expect: {
            bytes: [0x11, 0x33, 0x22, 0xEE],
            labels: {
                root_label: 0x0500,
                mid_label: 0x0500,
                leaf_label: 0x0501,
                after_nested: 0x0503
            }
        }
    },
    {
        name: '.include surfaces missing files with path info',
        sourceFile: 'include_missing.asm',
        expect: {
            success: false,
            errorsContains: ["Failed to include 'does_not_exist.asm'"]
        }
    },
    {
        name: '.print accumulates formatted output',
        sourceFile: 'print_basic.asm',
        expect: {
            bytes: [0x00],
            printMessages: ['value is 2'],
            noWarnings: true
        }
    },
    {
        name: 'DS reserves address space without emitting bytes',
        sourceFile: 'ds_basic.asm',
        expect: {
            bytes: [0x99],
            labels: {
                after_ds: 0x0014
            }
        }
    },
    {
        name: 'Literal formats and expressions evaluate correctly',
        sourceFile: 'literal_expression.asm',
        expect: {
            bytes: [0xFF, 0x1A, 0xA1, 0x0C, 0x34, 0x12, 0xEE],
            labels: {
                literal_block: 0x0010
            }
        }
    },
    {
        name: 'Local labels resolve within their scope',
        sourceFile: 'local_labels.asm',
        expect: {
            bytes: [0x00, 0xC3, 0x00, 0x07],
            labels: {
                start: 0x0700,
                '@spin_0': 0x0700
            }
        }
    },
    {
        name: 'Macros can wrap loops and emit repeated payloads',
        sourceFile: 'macro_loop_emit.asm',
        expect: {
            bytes: [0x11, 0x11, 0x22, 0x22, 0x22]
        }
    },
    {
        name: 'Macro-local labels stay unique across looped bodies',
        sourceFile: 'macro_loop_ramp.asm',
        expect: {
            bytes: [0x70, 0x70, 0x70, 0x70, 0x70],
            labels: {
                'MakeBlock_1.BlockStart': 0x0310,
                'MakeBlock_1.BlockEnd': 0x0312,
                'MakeBlock_2.BlockStart': 0x0312,
                'MakeBlock_2.BlockEnd': 0x0315
            }
        }
    },
    {
        name: 'Loop mismatches are caught inside macro bodies',
        sourceFile: 'macro_loop_missing_endloop.asm',
        expect: {
            success: false,
            errorsContains: ['Missing .endloop']
        }
    },
    {
        name: '.text emits ASCII bytes from string',
        sourceFile: 'text_basic.asm',
        expect: {
            bytes: [0x41, 0x42, 0x43]  // 'A', 'B', 'C'
        }
    },
    {
        name: '.text handles multiple character literals',
        sourceFile: 'text_char.asm',
        expect: {
            bytes: [0x58, 0x59, 0x5A]  // 'X', 'Y', 'Z'
        }
    },
    {
        name: '.text handles mixed strings and characters',
        sourceFile: 'text_mixed.asm',
        expect: {
            bytes: [0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x57]  // 'H', 'e', 'l', 'l', 'o', 'W'
        }
    },
    {
        name: '.encoding "ascii", "upper" converts to uppercase',
        sourceFile: 'encoding_upper.asm',
        expect: {
            bytes: [0x41, 0x42, 0x43]  // 'A', 'B', 'C' (uppercase)
        }
    },
    {
        name: '.encoding "ascii", "lower" converts to lowercase',
        sourceFile: 'encoding_lower.asm',
        expect: {
            bytes: [0x61, 0x62, 0x63]  // 'a', 'b', 'c' (lowercase)
        }
    },
    {
        name: '.encoding "ascii" defaults to mixed case',
        sourceFile: 'encoding_ascii_default.asm',
        expect: {
            bytes: [0x41, 0x62, 0x43]  // 'A', 'b', 'C' (mixed case)
        }
    },
    {
        name: '.encoding "screencodecommodore" converts to screencode',
        sourceFile: 'encoding_screencode.asm',
        expect: {
            bytes: [0x00, 0x01, 0x02]  // '@'->0x00, 'A'->0x01, 'B'->0x02
        }
    },
    {
        name: '.encoding rejects unknown encoding types',
        sourceFile: 'encoding_invalid.asm',
        expect: {
            success: false,
            errorsContains: ["Unknown encoding type 'invalid'"]
        }
    },
    {
        name: '.text requires at least one value',
        sourceFile: 'text_empty.asm',
        expect: {
            success: false,
            errorsContains: ['Missing value for .text']
        }
    },
    {
        name: '.text can have a label and affects subsequent addresses',
        sourceFile: 'text_label.asm',
        expect: {
            bytes: [0x48, 0x69, 0xFF],  // 'H', 'i', 0xFF
            labels: {
                message: 0x0100,
                after_text: 0x0102
            }
        }
    },
    {
        name: '.text handles escape sequences',
        sourceFile: 'text_escape.asm',
        expect: {
            bytes: [0x41, 0x0A, 0x42]  // 'A', newline, 'B'
        }
    },
    {
        name: '.text preserves repeated spaces',
        sourceFile: 'text_spaces.asm',
        expect: {
            bytes: [0x20, 0x20, 0x20, 0x61, 0x64, 0x64, 0x72, 0x65, 0x73, 0x73, 0x3A, 0x20, 0x20, 0x20, 0x31, 0x0A, 0x00]
        }
    },
    {
        name: 'Unary < (low byte) and > (high byte) operators work in directives and instructions',
        sourceFile: 'unary_lobyte_hibyte.asm',
        expect: {
            // Address 515 = 0x203
            // start: DB >CONST1  -> high byte of 0xF00 = 0x0F
            // mvi a, >start     -> opcode 0x3E (MVI A), high byte of 515 = 0x02
            // db <0x1234        -> low byte of 0x1234 = 0x34
            // db >0x1234        -> high byte of 0x1234 = 0x12
            bytes: [0x0F, 0x3E, 0x02, 0x34, 0x12],
            labels: {
                start: 515
            },
            consts: {
                CONST1: 0xF00,
                CONST2: 3  // low byte of 515 = 3
            },
            noWarnings: true
        }
    },
    {
        name: 'Unary and binary < > operators work together in expressions',
        sourceFile: 'unary_and_binary_operators.asm',
        expect: {
            // db <VALUE = 0x34, db >VALUE = 0x12
            // .if 5 > 3 -> true, emit 0xAA
            // .if 3 < 5 -> true, emit 0xBB
            // .if 3 > 5 -> false, skip 0xCC
            // .if 5 < 3 -> false, skip 0xDD
            // .if >VALUE == 0x12 -> true, emit 0xEE
            // .if <VALUE == 0x34 -> true, emit 0xFF
            bytes: [0x34, 0x12, 0xAA, 0xBB, 0xEE, 0xFF],
            noWarnings: true
        }
    },
    {
        name: 'Unary < and > operators work with various immediate instructions',
        sourceFile: 'unary_immediate_instructions.asm',
        expect: {
            // ADI >ADDR (0x12) = 0xC6, 0x12
            // SUI <ADDR (0x34) = 0xD6, 0x34
            // ANI <0xABCD (0xCD) = 0xE6, 0xCD
            // ORI >0xABCD (0xAB) = 0xF6, 0xAB
            // CPI <ADDR + 1 = <0x1234 + 1 = 0x34 + 1 = 0x35 = 0xFE, 0x35
            // IN <0x1200 (0x00) = 0xDB, 0x00
            // OUT >0x1200 (0x12) = 0xD3, 0x12
            bytes: [0xC6, 0x12, 0xD6, 0x34, 0xE6, 0xCD, 0xF6, 0xAB, 0xFE, 0x35, 0xDB, 0x00, 0xD3, 0x12],
            noWarnings: true
        }
    }
];

function formatByteArray(values: number[] | undefined): string {
    if (!values || !values.length) return '[]';
    return '[' + values.map(v => '0x' + v.toString(16).toUpperCase().padStart(2, '0')).join(', ') + ']';
}

function ensureSubstrings(haystack: string[] | undefined, needles: string[] | undefined, label: string, recorder: string[]) {
    if (!needles || !needles.length) return;
    if (!haystack || !haystack.length) {
        recorder.push(`Expected ${label} containing ${needles.join(' | ')}, but none were produced`);
        return;
    }
    for (const needle of needles) {
        const hit = haystack.some(msg => msg.includes(needle));
        if (!hit) recorder.push(`Expected ${label} to contain '${needle}'`);
    }
}

function compareBytes(actual: Buffer | undefined, expected: number[] | undefined, recorder: string[]) {
    if (!expected) return;
    if (!actual) {
        recorder.push('Assembler did not return any output bytes');
        return;
    }
    const actualArray = Array.from(actual.values());
    if (actualArray.length !== expected.length) {
        recorder.push(`Expected ${expected.length} bytes but received ${actualArray.length}`);
        recorder.push(`Expected: ${formatByteArray(expected)} | Actual: ${formatByteArray(actualArray)}`);
        return;
    }
    for (let i = 0; i < expected.length; i++) {
        if (actualArray[i] !== expected[i]) {
            recorder.push(`Byte ${i} mismatch (expected 0x${expected[i].toString(16)}, got 0x${actualArray[i].toString(16)})`);
            return;
        }
    }
}

function compareLabels(actual: AssembleResult['labels'], expected: Record<string, number> | undefined, recorder: string[]) {
    if (!expected) return;
    if (!actual) {
        recorder.push('Assembler did not return any label metadata');
        return;
    }
    for (const [label, addr] of Object.entries(expected)) {
        if (!(label in actual)) {
            recorder.push(`Missing expected label '${label}'`);
            continue;
        }
        const actualAddr = actual[label].addr;
        if (actualAddr !== addr) {
            recorder.push(`Label '${label}' expected 0x${addr.toString(16).toUpperCase()} but was 0x${actualAddr.toString(16).toUpperCase()}`);
        }
    }
}

function compareConsts(actual: AssembleResult['consts'], expected: Record<string, number> | undefined, recorder: string[]) {
    if (!expected) return;
    if (!actual) {
        recorder.push('Assembler did not return any constant metadata');
        return;
    }
    for (const [name, value] of Object.entries(expected)) {
        if (!(name in actual)) {
            recorder.push(`Missing expected constant '${name}'`);
            continue;
        }
        const actualValue = actual[name];
        if (actualValue !== value) {
            recorder.push(`Constant '${name}' expected ${value} (0x${value.toString(16).toUpperCase()}) but was ${actualValue} (0x${actualValue.toString(16).toUpperCase()})`);
        }
    }
}

function compareMap(actual: Record<number, number> | undefined, expected: Record<number, number> | undefined, recorder: string[]) {
    if (!expected) return;
    if (!actual) {
        recorder.push('Assembler did not return any line address map');
        return;
    }
    for (const [lineStr, addr] of Object.entries(expected)) {
        const lineNumber = Number(lineStr);
        const actualAddr = actual[lineNumber];
        if (typeof actualAddr !== 'number') {
            recorder.push(`Line ${lineNumber} missing from line-to-address map`);
            continue;
        }
        if ((actualAddr & 0xffff) !== (addr & 0xffff)) {
            recorder.push(`Line ${lineNumber} address expected 0x${addr.toString(16).toUpperCase()} but was 0x${actualAddr.toString(16).toUpperCase()}`);
        }
    }
}

function comparePrintMessages(actual: AssembleResult['printMessages'], expected: string[] | undefined, recorder: string[]) {
    if (!expected) return;
    const emitted = actual ? actual.map(msg => msg.text.trim()) : [];
    if (emitted.length !== expected.length) {
        recorder.push(`Expected ${expected.length} print messages but received ${emitted.length}`);
        recorder.push(`Expected: ${expected.join(' | ')} | Actual: ${emitted.join(' | ')}`);
        return;
    }
    for (let i = 0; i < expected.length; i++) {
        if (emitted[i] !== expected[i]) {
            recorder.push(`Print message ${i} mismatch (expected '${expected[i]}', got '${emitted[i]}')`);
        }
    }
}

function runTestCase(test: DirectiveTestCase): DirectiveTestResult {
    const filePath = path.join(directivesDir, test.sourceFile);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Test source not found: ${test.sourceFile}`);
    }
    const source = fs.readFileSync(filePath, 'utf8');
    const start = Date.now();
    const result = assemble(source, filePath);
    const durationMs = Date.now() - start;
    const details: string[] = [];
    const expectSuccess = test.expect.success !== false;

    if (expectSuccess) {
        if (!result.success || !result.output) {
            details.push('Expected assembly success but received errors');
            if (result.errors?.length) details.push(...result.errors);
            return { name: test.name, durationMs, passed: false, details };
        }
        compareBytes(result.output, test.expect.bytes, details);
        compareLabels(result.labels, test.expect.labels, details);
        compareConsts(result.consts, test.expect.consts, details);
        compareMap(result.map, test.expect.map, details);
        comparePrintMessages(result.printMessages, test.expect.printMessages, details);
        if (test.expect.noWarnings && result.warnings && result.warnings.length) {
            details.push(`Expected no warnings but received: ${result.warnings.join(' | ')}`);
        }
        ensureSubstrings(result.warnings, test.expect.warningsContains, 'warnings', details);
    } else {
        if (result.success) {
            details.push('Expected assembly failure but it succeeded');
        }
        ensureSubstrings(result.errors, test.expect.errorsContains, 'errors', details);
    }

    return { name: test.name, durationMs, passed: details.length === 0, details };
}

function main() {
    const results = tests.map(runTestCase);
    const passedCount = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed);

    console.log('Assembler Directive Tests');
    for (const res of results) {
        const status = res.passed ? 'PASS' : 'FAIL';
        console.log(`${status.padEnd(4)} ${res.name} (${res.durationMs} ms)`);
        if (!res.passed) {
            for (const detail of res.details) {
                console.log('  - ' + detail);
            }
        }
    }
    console.log(`Totals: ${passedCount}/${results.length} passed`);

    if (failed.length) {
        process.exitCode = 1;
    }
}

main();
