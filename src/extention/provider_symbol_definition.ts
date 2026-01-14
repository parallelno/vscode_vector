import * as vscode from 'vscode';
import { ensureSymbolCacheForDocument, resolveSymbolDefinition } from '../emulatorUI';

// Definition provider for labels/consts using emulator debug metadata
// It enables Ctrl+hover underline and click navigation to symbol definitions
// It uses cached symbol metadata from debug files.
export async function provideSymbolDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined>
{
  const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_@.][A-Za-z0-9_@.]*/);
  if (!wordRange) return undefined;
  const identifier = document.getText(wordRange);
  if (!identifier || identifier.startsWith('.')) return undefined;

  // Lazily load symbol metadata from a nearby debug file when not running the emulator
  await ensureSymbolCacheForDocument(document.uri.fsPath);

  const target = resolveSymbolDefinition(identifier);
  if (!target) return undefined;

  const targetUri = vscode.Uri.file(target.filePath);
  const targetRange = new vscode.Range(Math.max(0, target.line - 1), 0, Math.max(0, target.line - 1), 0);

  const link: vscode.DefinitionLink = {
    originSelectionRange: wordRange,
    targetUri,
    targetRange
  };

  return [link];
}

////////////////////////////////////////////////////////////////////////////////
//
// ANYTHING BELOW UNCHECKED YET
//
////////////////////////////////////////////////////////////////////////////////
