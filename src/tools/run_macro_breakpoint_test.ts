/**
 * Test script to verify that macro call lines are mapped to the first
 * instruction address in the macro body.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assembleAndWrite } from '../assembler';

type TestCase = {
    name: string;
    source: string;
    expectations: Array<{ line: number; expectedAddr: string; desc: string }>;
};

const testCases: TestCase[] = [
    {
        name: 'Simple macro call',
        source: `; Test macro breakpoint mapping (line 1)
.macro SimpleAdd()
    MOV A, B      ; This is the first instruction (line 3)
    ADD C         ; (line 4)
.endmacro

        .org 0x0100
start:
        NOP               ; line 9: 0x0100
        SimpleAdd()       ; line 10: should map to 0x0101 (first MOV in macro)
        HLT               ; line 11: 0x0103
`,
        expectations: [
            { line: 9, expectedAddr: '0x0100', desc: 'NOP at line 9' },
            { line: 10, expectedAddr: '0x0101', desc: 'Macro call at line 10 (should map to first instruction in macro body)' },
            { line: 11, expectedAddr: '0x0103', desc: 'HLT at line 11' }
        ]
    },
    {
        name: 'Multiple macro invocations',
        source: `; Multiple macro calls (line 1)
.macro Inc()
    INR A         ; line 3
.endmacro

        .org 0x0200
        NOP               ; line 7: 0x0200
        Inc()             ; line 8: should map to 0x0201
        NOP               ; line 9: 0x0202
        Inc()             ; line 10: should map to 0x0203
        HLT               ; line 11: 0x0204
`,
        expectations: [
            { line: 7, expectedAddr: '0x0200', desc: 'NOP at line 7' },
            { line: 8, expectedAddr: '0x0201', desc: 'First Inc() call at line 8' },
            { line: 9, expectedAddr: '0x0202', desc: 'NOP at line 9' },
            { line: 10, expectedAddr: '0x0203', desc: 'Second Inc() call at line 10' },
            { line: 11, expectedAddr: '0x0204', desc: 'HLT at line 11' }
        ]
    }
];

function runTestCase(testCase: TestCase, tmpDir: string): boolean {
    console.log(`\n=== ${testCase.name} ===`);
    
    const srcPath = path.join(tmpDir, 'test.asm');
    const romPath = path.join(tmpDir, 'test.rom');
    const debugPath = path.join(tmpDir, 'test.debug.json');

    fs.writeFileSync(srcPath, testCase.source, 'utf8');

    const result = assembleAndWrite(testCase.source, romPath, srcPath);

    if (!result.success) {
        console.error('FAIL: Assembly failed:', result.errors);
        return false;
    }

    if (!fs.existsSync(debugPath)) {
        console.error('FAIL: Debug JSON file not created');
        return false;
    }

    const debugData = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
    const lineAddresses = debugData.lineAddresses?.['test.asm'];

    if (!lineAddresses) {
        console.error('FAIL: No lineAddresses for test.asm in debug file');
        return false;
    }

    console.log('Line addresses:', JSON.stringify(lineAddresses, null, 2));

    let passed = true;
    for (const t of testCase.expectations) {
        const actual = lineAddresses[t.line];
        if (actual !== t.expectedAddr) {
            console.error(`FAIL: ${t.desc} - expected ${t.expectedAddr}, got ${actual}`);
            passed = false;
        } else {
            console.log(`PASS: ${t.desc} - ${actual}`);
        }
    }

    return passed;
}

function main() {
    const tmpDir = path.join(os.tmpdir(), `macro_bp_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    let allPassed = true;
    for (const testCase of testCases) {
        if (!runTestCase(testCase, tmpDir)) {
            allPassed = false;
        }
    }

    // Clean up - wrap in try-catch to handle any cleanup errors gracefully
    try {
        if (fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true });
        }
    } catch (err) {
        console.warn('Warning: Failed to clean up temp directory:', tmpDir);
    }

    if (!allPassed) {
        console.error('\nSome tests failed!');
        process.exit(1);
    }

    console.log('\nAll macro breakpoint tests passed!');
}

main();
