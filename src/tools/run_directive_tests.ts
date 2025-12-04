import * as fs from 'fs';
import * as path from 'path';
import { assemble } from '../assembler';
import { AssembleResult } from '../assembler/types';

type DirectiveTestExpectations = {
    success?: boolean;
    bytes?: number[];
    labels?: Record<string, number>;
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
const directivesDir = path.join(repoRoot, 'test', 'assembler', 'directives');

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
