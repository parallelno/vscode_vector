import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Definition provider for .include directives
// It enables Ctrl+hover underline and click navigation to included files
export async function provideIncludeDefinition(
	document: vscode.TextDocument,
	position: vscode.Position,
	token: vscode.CancellationToken)
	: Promise<vscode.Definition | vscode.DefinitionLink[] | undefined>
{
	const line = document.lineAt(position.line);
	const lineText = line.text;

	// Match .include "filename" or .include 'filename'
	// Strip trailing comments first for the match (uses same pattern as findIncludedFiles)
	const textWithoutComment = lineText.replace(/\/\/.*$|;.*$/, '');
	// Capture groups: (1) prefix including whitespace and .include keyword + space, (2) quote char, (3) path
	const includeRegex = /^(\s*\.include\s+)(["'])([^"']+)\2/i;
	const includeMatch = textWithoutComment.match(includeRegex);
	if (!includeMatch) {
		return undefined;
	}

	const includedPath = includeMatch[3];
	// Calculate the range of the path string based on the match
	// includeMatch[1] is the prefix ".include " part (including leading whitespace)
	// +1 for the opening quote character
	const pathStartIndex = includeMatch[1].length + 1;
	const pathEndIndex = pathStartIndex + includedPath.length;

	// Check if the cursor position is within the path (exclusive end)
	if (position.character < pathStartIndex || position.character >= pathEndIndex) {
		return undefined;
	}

	// Resolve the path relative to the current document
	let resolvedPath: string;
	if (path.isAbsolute(includedPath)) {
		resolvedPath = includedPath;
	} else {
		const baseDir = path.dirname(document.uri.fsPath);
		resolvedPath = path.resolve(baseDir, includedPath);
	}

	// Check if the file exists asynchronously
	try {
		await fs.promises.access(resolvedPath);
	} catch {
		return undefined;
	}

	const targetUri = vscode.Uri.file(resolvedPath);
	const targetRange = new vscode.Range(0, 0, 0, 0);
	const originRange = new vscode.Range(
		position.line, pathStartIndex,
		position.line, pathEndIndex
	);

	return [{
		targetUri,
		targetRange,
		originSelectionRange: originRange
	}] as vscode.DefinitionLink[];
};