import * as vscode from 'vscode';
import {
	isEmulatorPanelPaused,
	resolveDataDirectiveHover,
	resolveEmulatorHoverSymbol,
	resolveInstructionHover,
	ensureSymbolCacheForDocument } from '../emulatorUI';


export async function provideHover(
	document: vscode.TextDocument,
	position: vscode.Position)
	: Promise<vscode.Hover | undefined>
{
	// Data/memory hovers require a paused emulator; symbol hovers can work from cached metadata.
	if (isEmulatorPanelPaused()) {
		const dataHover = await resolveDataDirectiveHover(document, position);
		if (dataHover) {
			const valueWidth = Math.max(2, dataHover.unitBytes * 2);
			const memoryHex = '0x' + (dataHover.value >>> 0).toString(16).toUpperCase().padStart(valueWidth, '0');
			const memoryDec = (dataHover.value >>> 0).toString(10);
			const addressHex = '0x' + dataHover.address.toString(16).toUpperCase().padStart(4, '0');
			const md = new vscode.MarkdownString(undefined, true);
			md.appendMarkdown(`**${dataHover.directive.toUpperCase()} literal**\n\n`);
			md.appendMarkdown(`- addr: \`${addressHex}\`\n`);
			md.appendMarkdown(`- memory: \`${memoryHex}/${memoryDec}\``);
			if (typeof dataHover.sourceValue === 'number') {
				const normalizedSource = dataHover.sourceValue >>> 0;
				const sourceHex = '0x' + normalizedSource.toString(16).toUpperCase().padStart(valueWidth, '0');
				const sourceDec = normalizedSource.toString(10);
				md.appendMarkdown(`- source: \`${sourceHex}/${sourceDec}\``);
			}
			md.isTrusted = false;
			return new vscode.Hover(md, dataHover.range);
		}
	}

	const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_@.][A-Za-z0-9_@.]*/);
	const identifier = wordRange ? document.getText(wordRange) : '';
	const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
	if (identifier && !identifier.startsWith('.')) {
		// Ensure symbol cache is available when emulator is not running
		await ensureSymbolCacheForDocument(filePath);
		const symbol = resolveEmulatorHoverSymbol(identifier, filePath ? { filePath, line: position.line + 1 } : undefined);
		if (symbol) {
			if (symbol.kind === 'line') {
				const instructionHover = await resolveInstructionHover(document, position, symbol.value);
				if (instructionHover) {
					const addrHex = '0x' + instructionHover.address.toString(16).toUpperCase().padStart(4, '0');
					const memBytes = instructionHover.bytes.map(b => '0x' + b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
					const md = new vscode.MarkdownString(undefined, true);
					md.appendMarkdown(`${instructionHover.display}\n\n`);
					md.appendMarkdown(`- address: \`${addrHex}/${instructionHover.address}\`\n`);
					md.appendMarkdown(`- memory: \`${memBytes}\``);
					md.isTrusted = false;
					return new vscode.Hover(md, wordRange);
				}
			}

			const numericValue = Math.trunc(symbol.value);
			if (Number.isFinite(numericValue)) {
				const normalized16 = ((numericValue % 0x10000) + 0x10000) % 0x10000;
				const paddedHex = '0x' + normalized16.toString(16).toUpperCase().padStart(4, '0');
				const fullHex = numericValue < 0 ? `-0x${Math.abs(numericValue).toString(16).toUpperCase()}` : `0x${numericValue.toString(16).toUpperCase()}`;
				const hexValue = symbol.kind === 'const' ? fullHex : paddedHex;
				const decValue = numericValue.toString(10);
				const kindLabel = symbol.kind === 'const' ? 'constant' : symbol.kind === 'label' ? 'label' : 'address';
				const md = new vscode.MarkdownString(undefined, true);
				md.appendMarkdown(`**${identifier}** (${kindLabel})\n\n`);
				md.appendMarkdown(`- hex: \`${hexValue}\`\n`);
				md.appendMarkdown(`- dec: \`${decValue}\``);
				if (symbol.kind === 'line') {
					md.appendMarkdown('\n- note: derived from source line address');
				}
				md.isTrusted = false;
				return new vscode.Hover(md, wordRange);
			}
		}
	}

	return undefined;
}
