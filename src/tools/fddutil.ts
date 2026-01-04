#!/usr/bin/env node
/**
 * fddutil.ts
 *
 * TypeScript implementation of CLI Floppy Disk Drive tool.
 * Ported from the Python implementation at:
 * https://github.com/parallelno/fddutil_python/blob/main/src/fddutil.py
 * Originally written in JavaScript by Svofski.
 * https://github.com/svofski/v06c-fddutil
 *
 * This tool reads and writes FDD images, processes command-line arguments,
 * and manages files to be added to the FDD image.
 *
 * Usage:
 *
 * Show help
 * node ./out/tools/fddutil.js -h
 *
 * Add files to an FDD image
 * node ./out/tools/fddutil.js -r template.fdd -i file1.com -i file2.dat -o output.fdd

 *
 * Options:
 *   -h          Show help
 *   -t <file>   Optional template disk image (Commonly FDD image with a boot sector and the OS of your choice).
 *   -i <file>   File to add to the FDD image (can be specified multiple times)
 *   -o <file>   Output FDD image file
 */

import * as fs from 'fs';
import * as path from 'path';
import { Filesystem } from './fddimage';

export type BuildFddImageOptions = {
    templateFile?: string;
    inputFiles: string[];
    outputFile: string;
    log?: (message: string) => void;
};

export function buildFddImage(options: BuildFddImageOptions): { success: boolean; error?: string } {
    const log = options.log ?? (() => {});
    const templateFile = options.templateFile || '';
    const filesToPut = options.inputFiles || [];
    const outputFile = options.outputFile;

    if (!outputFile) {
        return { success: false, error: 'Output file is required' };
    }
    if (!filesToPut.length) {
        return { success: false, error: 'No input files provided' };
    }

    const fdd = new Filesystem();

    if (templateFile) {
        try {
            const templateData: Buffer = fs.readFileSync(templateFile);
            fdd.fromArray(new Uint8Array(templateData));
        } catch {
            return { success: false, error: `Error reading template file: ${templateFile}` };
        }
    }

    for (const name of filesToPut) {
        let data: Buffer;
        try {
            data = fs.readFileSync(name);
        } catch {
            return { success: false, error: `Could not read file ${name}. Please check if the file exists and is readable.` };
        }

        const basename = path.basename(name);
        fdd.saveFile(basename, new Uint8Array(data));
        log(`Saved file ${basename} to FDD image (${data.length} bytes)`);
    }

    try {
        const dir = path.dirname(outputFile);
        if (dir && dir !== '.' && dir !== path.sep) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (err) {
        return { success: false, error: `Error ensuring output directory exists: ${err instanceof Error ? err.message : String(err)}` };
    }

    try {
        fs.writeFileSync(outputFile, Buffer.from(fdd.bytes));
        log(`FDD image written to: ${outputFile}`);
        return { success: true };
    } catch {
        return { success: false, error: `Error writing FDD to: ${outputFile}` };
    }
}

function printUsage(): void {
    console.log('Usage: node ./out/tools/fddutil.js -r [template.fdd] -i file1.com [-i file2.dat] -o output.fdd');
    console.log('');
    console.log('Options:');
    console.log('  -h          Show help');
    console.log('  -t <file>   Optional template disk image (Commonly FDD image with a boot sector and the OS of your choice).');
    console.log('              (for example: -t ./res/fdd/rds308.fdd)');
    console.log('  -i <file>   File to add to the FDD image (can be specified multiple times)');
    console.log('  -o <file>   Output FDD image file');
}

function main(): void {
    // Default template file - can be overridden with -t option
    let templateFile = '';
    const filesToPut: string[] = [];
    let outputFile: string | null = null;

    try {
        let borrowHandler: ((value: string) => void) | null = null;
        const args = process.argv.slice(2);

        for (let i = 0; i < args.length; i++) {
            const arg = args[i].trim();

            if (borrowHandler) {
                borrowHandler(arg);
                borrowHandler = null;
                continue;
            }

            if (arg.startsWith('-')) {
                switch (arg) {
                    case '-h':
                        printUsage();
                        process.exit(0);
                        break;
                    case '-t':
                        // User-specified template file
                        borrowHandler = (v: string) => {
                            templateFile = v;
                        };
                        break;
                    case '-i':
                        // File to add to filesystem
                        borrowHandler = (v: string) => {
                            filesToPut.push(v);
                        };
                        break;
                    case '-o':
                        // Output file
                        borrowHandler = (v: string) => {
                            outputFile = v;
                        };
                        break;
                    default:
                        console.log(`arg: "${arg}" does not compute`);
                        throw new Error('Invalid argument');
                }
            } else {
                console.log(`arg: "${arg}" does not compute`);
                throw new Error('Invalid argument');
            }
        }

        if (filesToPut.length === 0 || !outputFile) {
            throw new Error('Missing required arguments');
        }
    } catch {
        printUsage();
        process.exit(1);
    }

    const result = buildFddImage({
        templateFile,
        inputFiles: filesToPut,
        outputFile: outputFile!,
        log: console.log,
    });

    if (!result.success) {
        console.error(result.error || 'Unknown error building FDD image');
        process.exit(1);
    }
}

// Run CLI only when executed directly (not when imported by the extension)
if (require.main === module) {
    main();
}
