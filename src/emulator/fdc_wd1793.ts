// Emulation of Soviet KR1818WG93 (КР1818ВГ93) Floppy Disk Controller (WD1793 analog)
//
// based on:
// https://github.com/libretro/fmsx-libretro/blob/master/EMULib/WD1793.c
// https://github.com/svofski/vector06sdl/blob/master/src/fd1793.h
// and the C++ implementation from Devector project

// ============================================================================
// FDD Constants (from fdd_consts.h)
// ============================================================================

export const FDD_SIDES = 2;
export const FDD_TRACKS_PER_SIDE = 82;
export const FDD_SECTORS_PER_TRACK = 5;
export const FDD_SECTOR_LEN = 1024;
export const FDD_SIZE = FDD_SIDES * FDD_TRACKS_PER_SIDE * FDD_SECTORS_PER_TRACK * FDD_SECTOR_LEN;

// ============================================================================
// WD1793 Constants
// ============================================================================

// Status register flags
const F_BUSY = 0x01;       // Controller is executing a command
const F_INDEX = 0x02;      // Index pulse from drive
const F_DRQ = 0x02;        // Data request (shared bit with INDEX for type II/III commands)
const F_TRACK0 = 0x04;     // Head at track 0
const F_LOSTDATA = 0x04;   // Data was lost during transfer
const F_CRCERR = 0x08;     // CRC error in ID field
const F_SEEKERR = 0x10;    // Seek operation failed
const F_NOTFOUND = 0x10;   // Sector not found
const F_HEADLOAD = 0x20;   // Head loaded
const F_READONLY = 0x40;   // Disk is write-protected
const F_NOTREADY = 0x80;   // Drive not ready

// Error code bits
const F_ERRCODE = 0x18;

// IRQ/DRQ flags
const WD1793_IRQ = 0x80;   // Interrupt request pending
const WD1793_DRQ = 0x40;   // Data request pending

// Command bits
const C_SIDECOMP = 0x02;   // Side compare flag
const C_LOADHEAD = 0x08;   // Load head flag (type I commands)
const C_SIDE = 0x08;       // Side select (type II/III commands)
const C_IRQ = 0x08;        // Immediate IRQ (force interrupt)
const C_SETTRACK = 0x10;   // Update track register (step commands)

// System register bits
const S_DRIVE = 0x03;      // Drive select mask (bits 0-1)
const S_RESET = 0x04;      // Reset bit
const S_HALT = 0x08;       // Halt bit

// ============================================================================
// Port enum
// ============================================================================

export enum Port {
    COMMAND = 0,
    STATUS = 0,
    TRACK = 1,
    SECTOR = 2,
    DATA = 3,
    READY = 4,
    SYSTEM = 4
}

// ============================================================================
// FDC Info structures
// ============================================================================

export interface FdcInfo {
    drive: number;       // Current disk #
    side: number;        // Current side #
    track: number;       // Current track #
    lastS: number;       // Last STEP direction
    irq: number;         // 0x80: IRQ pending, 0x40: DRQ pending
    wait: number;        // Expiration counter
    cmd: number;         // Last command
    rwLen: number;       // The length of the transferred data
    position: number;    // sector addr
}

export interface DiskInfo {
    path: string;
    updated: boolean;
    reads: number;
    writes: number;
    mounted: boolean;
}

// ============================================================================
// FDisk class - represents a single floppy disk
// ============================================================================

export class FDisk {
    data: Uint8Array;
    header: Uint8Array;  // current header, result of Seek()
    updated: boolean = false;
    path: string = '';
    mounted: boolean = false;
    reads: number = 0;
    writes: number = 0;

    constructor() {
        this.data = new Uint8Array(FDD_SIZE);
        this.header = new Uint8Array(6);
    }

    mount(diskData: Uint8Array, diskPath: string): void {
        // Copy disk data
        const copyLen = Math.min(diskData.length, FDD_SIZE);
        this.data.set(diskData.subarray(0, copyLen));
        // Fill remaining with zeros if source is smaller
        if (copyLen < FDD_SIZE) {
            this.data.fill(0, copyLen);
        }
        this.path = diskPath;
        this.mounted = true;
        this.updated = false;
        this.reads = 0;
        this.writes = 0;
    }

    getData(): Uint8Array {
        return this.data;
    }

    getDisk(): FDisk | null {
        return this.mounted ? this : null;
    }
}

// ============================================================================
// Fdc1793 class - WD1793 Floppy Disk Controller emulation
// ============================================================================

export class Fdc1793 {
    static readonly DRIVES_MAX = 4;

    private disks: FDisk[];
    private regs: Uint8Array;  // Registers [STATUS/COMMAND, TRACK, SECTOR, DATA, SYSTEM]
    private drive: number = 0; // Current disk #
    private side: number = 0;  // Current side #
    private track: number = 0; // Current track #
    private lastS: number = 0; // Last STEP direction
    private irq: number = 0;   // 0x80: IRQ pending, 0x40: DRQ pending
    private wait: number = 0;  // Expiration counter
    private cmd: number = 0;   // Last command
    private rwLen: number = 0; // The length of the transferred data

    private ptr: number = 0;   // Pointer offset into disk data
    private headerPtr: number = 0;  // Pointer for reading header data
    private readingHeader: boolean = false; // Flag for READ-ADDRESS command
    private disk: FDisk | null = null; // Current disk image

    constructor() {
        this.disks = [];
        for (let i = 0; i < Fdc1793.DRIVES_MAX; i++) {
            this.disks.push(new FDisk());
        }
        this.regs = new Uint8Array(5);
        this.reset();
    }

    /**
     * Seek to given side / track / sector.
     * Returns sector offset (position) on success or -1 on failure.
     */
    private seek(sideID: number, trackID: number, sectorID: number): number {
        if (!this.disk) return -1;

        const sectors = FDD_SECTORS_PER_TRACK * (trackID * FDD_SIDES + sideID);
        // In CHS addressing the sector numbers always start at 1,
        // but in the data buffer the sector numbers always start at 0.
        const sectorAdjusted = Math.max(0, sectorID - 1);
        const position = (sectors + sectorAdjusted) * FDD_SECTOR_LEN;

        // Store header for each sector
        this.disk.header[0] = trackID;
        this.disk.header[1] = sideID;
        this.disk.header[2] = sectorID;

        return position;
    }

    /**
     * Resets the state of the WD1793 FDC.
     */
    private reset(): void {
        this.regs[0] = 0x00;
        this.regs[1] = 0x00;
        this.regs[2] = 0x00;
        this.regs[3] = 0x00;
        this.regs[4] = S_RESET | S_HALT;
        this.side = 0;
        this.track = 0;
        this.lastS = 0;
        this.irq = 0;
        this.rwLen = 0;
        this.wait = 0;
        this.cmd = 0xD0;
        this.ptr = 0;
        this.headerPtr = 0;
        this.readingHeader = false;
    }

    /**
     * Mount a disk image to a drive.
     */
    mount(driveIdx: number, data: Uint8Array, path: string): void {
        const idx = driveIdx % Fdc1793.DRIVES_MAX;
        this.disks[idx].mount(data, path);
        if (idx === this.drive) {
            this.reset();
        }
    }

    /**
     * Reads a value from a WD1793 register.
     * Returns the read data on success or 0xFF on failure (bad register address).
     */
    read(port: Port): number {
        switch (port) {
            case Port.STATUS: {
                let status = this.regs[0];
                // If no disk present, set F_NOTREADY
                if (!this.disk) {
                    status |= F_NOTREADY;
                }

                if ((this.cmd < 0x80) || (this.cmd === 0xD0)) {
                    // Keep flipping F_INDEX bit as the disk rotates
                    this.regs[0] = (this.regs[0] ^ F_INDEX) & (F_INDEX | F_BUSY | F_NOTREADY | F_READONLY | F_TRACK0);
                } else {
                    // When reading status, clear all bits but F_BUSY and F_NOTREADY
                    this.regs[0] &= F_BUSY | F_NOTREADY | F_READONLY | F_DRQ;
                }
                return status;
            }

            case Port.TRACK:
            case Port.SECTOR:
                return this.regs[port];

            case Port.DATA:
                if (this.rwLen > 0 && this.disk) {
                    // Check if reading header data (READ-ADDRESS command)
                    if (this.readingHeader) {
                        this.regs[Port.DATA] = this.disk.header[this.headerPtr++];
                    } else {
                        // Read sector data
                        this.regs[Port.DATA] = this.disk.data[this.ptr++];
                    }
                    this.disk.reads++;
                    if (--this.rwLen) {
                        this.wait = 255; // Reset timeout watchdog
                        // Advance to the next sector if needed (only for sector reads)
                        if (!this.readingHeader && !(this.rwLen & (FDD_SECTOR_LEN - 1))) {
                            this.regs[Port.SECTOR]++;
                        }
                    } else {
                        // Read completed
                        this.regs[0] &= ~(F_DRQ | F_BUSY);
                        this.irq = WD1793_IRQ;
                        this.readingHeader = false;
                    }
                }
                return this.regs[Port.DATA];

            case Port.READY:
                // After some idling, stop read/write operations
                if (this.wait) {
                    if (--this.wait === 0) {
                        this.rwLen = 0;
                        this.regs[0] = (this.regs[0] & ~(F_DRQ | F_BUSY)) | F_LOSTDATA;
                        this.irq = WD1793_IRQ;
                    }
                }
                return this.irq;
        }

        return 0xFF; // Bad register case
    }

    /**
     * Writes a value into the WD1793 register.
     * Returns WD1793_IRQ or WD1793_DRQ
     */
    write(port: Port, val: number): number {
        let J: number;

        switch (port) {
            case Port.COMMAND:
                // Reset an interrupt request
                this.irq = 0;

                // If it is FORCE-IRQ command...
                if ((val & 0xF0) === 0xD0) {
                    // Reset any executing command
                    this.rwLen = 0;
                    this.cmd = 0xD0;
                    // Either reset BUSY flag or reset all flags if BUSY=0
                    if (this.regs[0] & F_BUSY) {
                        this.regs[0] &= ~F_BUSY;
                    } else {
                        this.regs[0] = (this.track ? 0 : F_TRACK0) | F_INDEX;
                    }
                    // Cause immediate interrupt if requested
                    if (val & C_IRQ) {
                        this.irq = WD1793_IRQ;
                    }
                    return this.irq;
                }

                // If busy, drop out
                if (this.regs[0] & F_BUSY) break;

                // Reset status register
                this.regs[0] = 0x00;
                this.cmd = val;

                // Handling the rest commands
                switch (val & 0xF0) {
                    case 0x00: // RESTORE (seek track 0)
                        this.track = 0;
                        this.regs[0] = F_INDEX | F_TRACK0 | ((val & C_LOADHEAD) ? F_HEADLOAD : 0);
                        this.regs[1] = 0;
                        this.irq = WD1793_IRQ;
                        break;

                    case 0x10: // SEEK
                        // Reset any executing command
                        this.rwLen = 0;
                        this.track = this.regs[3];
                        this.regs[0] = F_INDEX
                            | (this.track ? 0 : F_TRACK0)
                            | ((val & C_LOADHEAD) ? F_HEADLOAD : 0);
                        this.regs[1] = this.track;
                        this.irq = WD1793_IRQ;
                        break;

                    case 0x20: // STEP
                    case 0x30: // STEP-AND-UPDATE
                    case 0x40: // STEP-IN
                    case 0x50: // STEP-IN-AND-UPDATE
                    case 0x60: // STEP-OUT
                    case 0x70: // STEP-OUT-AND-UPDATE
                        // Either store or fetch step direction
                        if (val & 0x40) {
                            this.lastS = val & 0x20;
                        } else {
                            val = (val & ~0x20) | this.lastS;
                        }
                        // Step the head, update track register if requested
                        if (val & 0x20) {
                            if (this.track) this.track--;
                        } else {
                            this.track++;
                        }
                        // Update track register if requested
                        if (val & C_SETTRACK) {
                            this.regs[1] = this.track;
                        }
                        // Update status register
                        this.regs[0] = F_INDEX | (this.track ? 0 : F_TRACK0);
                        // Generate IRQ
                        this.irq = WD1793_IRQ;
                        break;

                    case 0x80: // READ-SECTORS
                    case 0x90: // READ-SECTORS (multi)
                        {
                            // Seek to the requested sector
                            const seekSide = (val & C_SIDECOMP) ? ((val & C_SIDE) ? 1 : 0) : this.side;
                            const position = this.seek(seekSide, this.regs[1], this.regs[2]);

                            // If seek successful, set up reading operation
                            if (position < 0) {
                                this.regs[0] = (this.regs[0] & ~F_ERRCODE) | F_NOTFOUND;
                                this.irq = WD1793_IRQ;
                            } else {
                                this.ptr = position;
                                this.rwLen = FDD_SECTOR_LEN
                                    * ((val & 0x10) ? (FDD_SECTORS_PER_TRACK - this.regs[2] + 1) : 1);
                                this.regs[0] |= F_BUSY | F_DRQ;
                                this.irq = WD1793_DRQ;
                                this.wait = 255;
                            }
                        }
                        break;

                    case 0xA0: // WRITE-SECTORS
                    case 0xB0: // WRITE-SECTORS (multi)
                        {
                            // Seek to the requested sector
                            const seekSide = (val & C_SIDECOMP) ? ((val & C_SIDE) ? 1 : 0) : this.side;
                            const position = this.seek(seekSide, this.regs[1], this.regs[2]);

                            // If seek successful, set up writing operation
                            if (position < 0) {
                                this.regs[0] = (this.regs[0] & ~F_ERRCODE) | F_NOTFOUND;
                                this.irq = WD1793_IRQ;
                            } else {
                                this.ptr = position;
                                this.rwLen = FDD_SECTOR_LEN
                                    * ((val & 0x10) ? (FDD_SECTORS_PER_TRACK - this.regs[2] + 1) : 1);
                                this.regs[0] |= F_BUSY | F_DRQ;
                                this.irq = WD1793_DRQ;
                                this.wait = 255;
                                if (this.disk) {
                                    this.disk.updated = true;
                                }
                            }
                        }
                        break;

                    case 0xC0: // READ-ADDRESS
                        {
                            // Read first sector address from the track
                            let foundPosition = -1;
                            if (this.disk) {
                                for (J = 0; J < 256; J++) {
                                    const position = this.seek(this.side, this.track, J);
                                    if (position >= 0) {
                                        foundPosition = position;
                                        break;
                                    }
                                }
                            }
                            // If address found, initiate data transfer
                            if (foundPosition < 0) {
                                this.regs[0] |= F_NOTFOUND;
                                this.irq = WD1793_IRQ;
                            } else {
                                // Set up for header reading (6 bytes from disk.header)
                                this.readingHeader = true;
                                this.headerPtr = 0;
                                this.rwLen = 6;
                                this.regs[0] |= F_BUSY | F_DRQ;
                                this.irq = WD1793_DRQ;
                                this.wait = 255;
                            }
                        }
                        break;

                    case 0xE0: // READ-TRACK
                        // Not implemented
                        break;

                    case 0xF0: // WRITE-TRACK, i.e., format
                        {
                            // The full protocol is not implemented (involves parsing lead-in & lead-out);
                            // it only sets the track data to 0xE5
                            let position = this.seek(0, this.regs[1], 1);
                            if (position >= 0 && this.disk) {
                                this.disk.data.fill(0xE5, position, position + FDD_SECTOR_LEN * FDD_SECTORS_PER_TRACK);
                                this.disk.updated = true;
                            }
                            if (FDD_SIDES > 1) {
                                position = this.seek(1, this.regs[1], 1);
                                if (position >= 0 && this.disk) {
                                    this.disk.data.fill(0xE5, position, position + FDD_SECTOR_LEN * FDD_SECTORS_PER_TRACK);
                                    this.disk.updated = true;
                                }
                            }
                        }
                        break;

                    default:
                        // UNKNOWN command
                        break;
                }
                break;

            case Port.TRACK:
            case Port.SECTOR:
                if (!(this.regs[0] & F_BUSY)) {
                    this.regs[port] = val;
                }
                break;

            case Port.DATA:
                // When writing data, store value to disk
                if (this.rwLen > 0 && this.disk) {
                    // Write data
                    this.disk.data[this.ptr++] = val;
                    this.disk.updated = true;
                    this.disk.writes++;
                    // Decrement length
                    if (--this.rwLen) {
                        this.wait = 255; // Reset timeout watchdog
                        // Advance to the next sector as needed
                        if (!(this.rwLen & (FDD_SECTOR_LEN - 1))) {
                            this.regs[2]++;
                        }
                    } else {
                        // Write completed
                        this.regs[0] &= ~(F_DRQ | F_BUSY);
                        this.irq = WD1793_IRQ;
                    }
                }
                // Save last written value
                this.regs[Port.DATA] = val;
                break;

            case Port.SYSTEM:
                // Reset controller if S_RESET goes up
                // Note: Original has a TODO about whether reset is still required
                // if ((this.regs[4] ^ val) & val & S_RESET) {
                //     this.reset();
                // }

                this.drive = val & S_DRIVE;
                this.disk = this.disks[this.drive].getDisk();

                // Kishinev FDC: 0011xSDD
                //   S - side
                //   DD - drive index: 0, 1, 2, 3
                this.side = ((~val) >> 2) & 1; // inverted side

                // Save the last written value
                this.regs[Port.SYSTEM] = val;
                break;
        }

        return this.irq;
    }

    /**
     * Get FDC info for debugging.
     */
    getFdcInfo(): FdcInfo {
        return {
            drive: this.drive,
            side: this.side,
            track: this.track,
            lastS: this.lastS,
            irq: this.irq,
            wait: this.wait,
            cmd: this.cmd,
            rwLen: this.rwLen,
            position: this.ptr
        };
    }

    /**
     * Get disk info for a specific drive.
     */
    getFddInfo(driveIdx: number): DiskInfo {
        const idx = driveIdx % Fdc1793.DRIVES_MAX;
        return {
            path: this.disks[idx].path,
            updated: this.disks[idx].updated,
            reads: this.disks[idx].reads,
            writes: this.disks[idx].writes,
            mounted: this.disks[idx].mounted
        };
    }

    /**
     * Get a copy of the disk image data.
     */
    getFddImage(driveIdx: number): Uint8Array {
        const idx = driveIdx % Fdc1793.DRIVES_MAX;
        return new Uint8Array(this.disks[idx].data);
    }

    /**
     * Reset the updated flag for a drive.
     */
    resetUpdate(driveIdx: number): void {
        const idx = driveIdx % Fdc1793.DRIVES_MAX;
        this.disks[idx].updated = false;
    }
}

export default Fdc1793;
